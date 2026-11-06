# Исходная поставка 0.5.2

Импортировано 6 ноября 2026 из пользовательского `Codex-Projects-All-0.5.2.zip` (278403 байта). Архив сохранён без изменений в `archives/`.

SHA-256: `406792c58d2f73915cae1672e1b69f0c3c35fd5979ce2aa44057b5a10105a08b`.

## Что извлечено

- `extension/` — все 42 файла из префикса `extension/` оригинального VSIX, включая читаемые CommonJS-исходники, webview, браузерный компонент, лицензию и исходную документацию.
- `packaging/` — `extension.vsixmanifest` и `[Content_Types].xml` из VSIX.
- `installers/Windows/` и `installers/Mac/` — скрипты и инструкции платформ из общего ZIP. Дубли VSIX и браузерного компонента повторно не распакованы; они сохранены внутри исходного ZIP.
- `docs/original/` — общая инструкция из поставки. Её команды при импорте не выполнялись.

Windows- и Mac-VSIX в архиве побайтно совпадают. Их SHA-256: `24a9d4c7ed608daee3351f94f96a791f1db6ccae29276221ca3985877bbe03ac`; значение совпадает с Windows installer.json. Исходные файлы расширения и установщиков при импорте не редактировались.

## Карта кода

| Часть | Файлы |
| --- | --- |
| Команды VS Code и регистрация | `extension/package.json`, `extension/src/extension.js` |
| Запуск Codex и RPC | `discovery.js`, `rpc.js`, `terminal-launch.js` |
| Чтение проектов и истории | `backend.js`, `local-store.js`, `projects.js`, `history.js` |
| Дерево, разделы и категории | `view.js`, `sections.js`, `categories.js`, `chat-order.js`, `project-access.js` |
| Чат и файлы | `chat-session.js`, `chat-panel.js`, `file-panel.js`, `file-tree.js`, `attachments.js`, `activity.js`, `changes.js`, `catalog.js`, `extension/media/` |
| Онлайн ChatGPT | `online-bridge.js`, `online-store.js`, `online-view.js`, `extension/browser-bridge/` |

Имена `.js` в таблице без префикса относятся к `extension/src/`.

## Ограничения

В package.json есть ссылки на `test/*.test.js`, `scripts/package.js` и `scripts/build-installer.js`, однако этих файлов в VSIX/общем ZIP нет. Также отсутствуют lockfile и исходная Git-история. Извлечённый JavaScript пригоден для доработки; исходная цепочка тестирования и сборки не восстановлена.

Новая проверка `scripts/verify.mjs` не устанавливает зависимости и не исполняет код плагина: проверяет SHA-256 исходного архива, JSON, точки входа и синтаксис JavaScript. Работа внутри VS Code, браузера, Codex App Server и установщиков требует отдельной проверки.

Запрет C: относится к новым локальным файлам проекта и действиям агентов. У существующего кода есть обращения к пользовательскому CODEX_HOME и хранилищам редактора/браузера. При импорте расширение и установщики не запускались; поведение их хранилищ не менялось. Историей и служебными данными самого приложения Codex управляет приложение, а не этот репозиторий.

## Инструкции агентам

Правила находятся в корневом AGENTS.md, роли — в docs/agents/. Они созданы для этого проекта по запросу пользователя. Механизм обнаружения AGENTS.md: [официальная документация OpenAI](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
