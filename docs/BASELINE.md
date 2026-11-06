# Исходная поставка 0.5.2

Импортировано 6 ноября 2026 из пользовательского `Codex-Projects-All-0.5.2.zip` (278403 байта). Архив сохранён без изменений в `archives/`.

SHA-256: `406792c58d2f73915cae1672e1b69f0c3c35fd5979ce2aa44057b5a10105a08b`.

## Хранение после публикации Releases

Неизменённая поставка опубликована в [GitHub Release v0.5.2](https://github.com/drkhisa/codex-projects-explorer/releases/tag/v0.5.2)
на коммите первоначального импорта `6f908b08ebf7678ae4b0c4e96ddbde21a3546fd8`.
Assets: [оригинальный ZIP](https://github.com/drkhisa/codex-projects-explorer/releases/download/v0.5.2/Codex-Projects-All-0.5.2.zip)
и [SHA256SUMS](https://github.com/drkhisa/codex-projects-explorer/releases/download/v0.5.2/SHA256SUMS).
Размер и SHA-256 ZIP после скачивания подтверждены. Исторический baseline
не назначается Latest; текущая версия указана в README.

`archives/` больше не входит в текущий Git tree и исключена через `.gitignore`.
Локальные оригиналы сохранены побайтно; старые коммиты не переписывались.
Версия, имя, размер, SHA-256 и URL закреплены в `packaging/baseline.json`.
После нового клона выполнить из корня:

```powershell
rtk proxy powershell -NoProfile -Command '. .\scripts\Enter-Project.ps1; rtk proxy python scripts/fetch-baseline.py'
```

Загрузчик сохраняет только проверенные по pin данные в локальную `archives/`.
Существующий ZIP не перезаписывается; отсутствующий SHA256SUMS создаётся из pin,
а не из непроверенного удалённого checksum-файла. Затем доступны verify и упаковка.
Содержимое ZIP не исполняется. Порядок: [docs/RELEASE.md](RELEASE.md).

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
