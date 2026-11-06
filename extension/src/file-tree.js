'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
// Opaque node IDs keep webview messages from supplying arbitrary filesystem paths.
class FileTree {
  constructor() { this.nodes = new Map(); this.byPath = new Map(); this.roots = []; }
  static async create(paths) {
    const tree = new FileTree(), seen = new Set();
    for (const input of paths) {
      try {
        const real = await fs.realpath(input);
        if (seen.has(real)) continue;
        if (!(await fs.stat(real)).isDirectory()) throw new Error('Это не папка');
        seen.add(real); const node = tree.add({ absolute: real, root: real, name: path.basename(input) || real, directory: true, ancestors: [] });
        tree.roots.push(node);
      } catch (error) {
        tree.roots.push({ id: crypto.randomUUID(), name: path.basename(input) || input, path: input, directory: true, disabled: true, error: 'Папка недоступна: ' + error.message });
      }
    }
    return tree;
  }
  add(data) {
    const key = data.root + '\0' + data.absolute;
    const prior = this.byPath.get(key);
    const node = { ...data, id: prior || crypto.randomUUID() };
    this.nodes.set(node.id, node); this.byPath.set(key, node.id); return this.public(node);
  }
  public(node) { return { id: node.id, name: node.name, path: node.absolute, directory: node.directory, symlink: !!node.symlink, disabled: !!node.disabled, error: node.error || '' }; }
  async resolve(id, directory) {
    const node = this.nodes.get(id);
    if (!node || node.disabled) throw new Error('Этот файл больше недоступен. Обновите дерево.');
    const real = await fs.realpath(node.absolute);
    if (!inside(node.root, real)) throw new Error('Ссылка ведёт за пределы выбранной папки проекта.');
    const stat = await fs.stat(real);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(directory ? 'Папка больше недоступна.' : 'Выберите обычный файл.');
    if (directory && node.ancestors.includes(real)) throw new Error('Циклическая ссылка на родительскую папку.');
    return { node, real };
  }
  async children(id) {
    const { node, real } = await this.resolve(id, true);
    const entries = await fs.readdir(real, { withFileTypes: true });
    const children = await Promise.all(entries.map(async entry => {
      const absolute = path.join(node.absolute, entry.name);
      const child = { absolute, root: node.root, name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink(), ancestors: [...node.ancestors, real] };
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.realpath(absolute), stat = await fs.stat(target); child.directory = stat.isDirectory();
          if (!inside(node.root, target)) { child.disabled = true; child.error = 'Ссылка за пределы проекта'; }
          else if (child.directory && child.ancestors.includes(target)) { child.disabled = true; child.error = 'Ссылка на родительскую папку'; }
          else if (!stat.isFile() && !stat.isDirectory()) { child.disabled = true; child.error = 'Необычный тип файла'; }
        } catch { child.disabled = true; child.error = 'Ссылка недоступна'; }
      } else if (!entry.isFile() && !entry.isDirectory()) { child.disabled = true; child.error = 'Необычный тип файла'; }
      return this.add(child);
    }));
    return children.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }
  async file(id) { return (await this.resolve(id, false)).real; }
}
module.exports = { FileTree, inside };
