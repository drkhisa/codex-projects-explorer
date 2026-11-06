#!/bin/bash
# Installs the VS Code extension only. Browser store publication is separate.
set -u
installer_root="$(cd -- "$(dirname -- "$0")" && pwd -P)"
code_app=""
for candidate in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app"; do
  if [ -x "$candidate/Contents/Resources/app/bin/code" ]; then code_app="$candidate"; break; fi
done
if [ -z "$code_app" ]; then
  code_app="$(/usr/bin/osascript <<'APPLESCRIPT'
try
  set editorApp to choose application with prompt "Выберите установленный Visual Studio Code" as alias
  return POSIX path of editorApp
on error
  return ""
end try
APPLESCRIPT
)"
fi
code_app="${code_app%/}"
code_cli="$code_app/Contents/Resources/app/bin/code"
if [ ! -x "$code_cli" ]; then
  /usr/bin/osascript -e 'display alert "VS Code не найден" message "Сначала установите Visual Studio Code в Программы, затем запустите этот файл ещё раз."'
  exit 1
fi
vsix_name=""
for candidate in "$installer_root"/codex-projects-explorer-*.vsix; do
  if [ -f "$candidate" ]; then vsix_name="$candidate"; break; fi
done
if [ -z "$vsix_name" ]; then
  /usr/bin/osascript -e 'display alert "Не найден файл VSIX" message "Распакуйте общий архив целиком. Файл VSIX должен лежать рядом с Установить.command."'
  exit 1
fi
if "$code_cli" --install-extension "$vsix_name" --force; then
  /usr/bin/osascript -e 'display dialog "Расширение VS Code установлено. Полностью закройте VS Code через Cmd+Q и откройте заново. Браузерный компонент этим сценарием не установлен; его публикация в магазине ещё не завершена." buttons {"OK"} default button "OK"'
else
  /usr/bin/osascript -e 'display alert "Установка не завершена" message "Сообщение VS Code показано в окне Терминала. Можно установить приложенный VSIX вручную через Extensions: Install from VSIX…"'
  exit 1
fi
