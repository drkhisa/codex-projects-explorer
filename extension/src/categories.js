'use strict';
const crypto = require('node:crypto');
const { threadKey } = require('./sections');
function settingsFor(store, key) {
  const value = store[key] || {}, items = Array.isArray(value.items) ? value.items.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string') : [];
  return { items, assignments: value.assignments && typeof value.assignments === 'object' ? value.assignments : {} };
}
function checkName(name, items, except) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value || value.length > 80 || /[\x00-\x1f]/.test(value)) throw new Error('Название категории: от 1 до 80 символов, без переносов строк.');
  if (items.some(c => c.id !== except && c.name.toLocaleLowerCase() === value.toLocaleLowerCase())) throw new Error('В этом проекте уже есть такая категория.');
  return value;
}
function addCategory(settings, name) {
  const category = { id: crypto.randomUUID(), name: checkName(name, settings.items) };
  return { settings: { ...settings, items: [...settings.items, category] }, category };
}
function renameCategory(settings, id, name) {
  if (!settings.items.some(c => c.id === id)) throw new Error('Категория больше не существует.');
  const value = checkName(name, settings.items, id);
  return { ...settings, items: settings.items.map(c => c.id === id ? { ...c, name: value } : c) };
}
function removeCategory(settings, id) {
  return { items: settings.items.filter(c => c.id !== id), assignments: Object.fromEntries(Object.entries(settings.assignments).filter(([, value]) => value !== id)) };
}
function assignCategory(settings, thread, id) {
  if (id && !settings.items.some(c => c.id === id)) throw new Error('Категория больше не существует.');
  const assignments = { ...settings.assignments }; if (id) assignments[threadKey(thread)] = id; else delete assignments[threadKey(thread)];
  return { ...settings, assignments };
}
function splitCategories(settings, threads) {
  const categories = settings.items.map(c => ({ ...c, threads: [] })), byId = new Map(categories.map(c => [c.id, c])), direct = [];
  for (const thread of threads) { const category = byId.get(settings.assignments[threadKey(thread)]); if (category) category.threads.push(thread); else direct.push(thread); }
  return { categories, direct };
}
module.exports = { settingsFor, addCategory, renameCategory, removeCategory, assignCategory, splitCategories };
