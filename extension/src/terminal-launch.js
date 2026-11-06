'use strict';
const path = require('node:path');
const { validId } = require('./local-store');

function quotePowerShell(value) {
  const s = String(value);
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error('Путь содержит недопустимый управляющий символ.');
  // Literal PowerShell string: $, backticks, &, ; and parentheses have no syntax here.
  return "'" + s.replace(/'/g, "''") + "'";
}

function resumeLaunch({ platform, executable, id, home, cwd, name, windowsDirectory, noDaemon = true }) {
  if (!validId(id)) throw new Error('Некорректный идентификатор чата.');
  const base = {
    name: `Codex: ${String(name).slice(0, 45)}`,
    ...(cwd ? { cwd } : {}),
    env: { CODEX_HOME: home, CODEX_THREAD_ID: null, CODEX_SESSION_ID: null, CODEX_TOOL_CALL_ID: null }
  };
  const argv = [...(noDaemon ? ['--no-daemon'] : []), 'resume', id];
  if (platform !== 'win32') return { ...base, shellPath: executable, shellArgs: argv };
  if (!windowsDirectory || !path.win32.isAbsolute(windowsDirectory)) throw new Error('Не найден каталог Windows для запуска PowerShell.');
  const binary = quotePowerShell(executable), threadId = quotePowerShell(id);
  const command = [
    '$global:LASTEXITCODE = 0',
    'try {',
    `  & ${binary} '--version'`,
    '  if ($LASTEXITCODE -eq 0) {',
    `    & ${binary} ${noDaemon ? "'--no-daemon' " : ''}'resume' ${threadId}`,
    '    if ($LASTEXITCODE -ne 0) {',
    '      Write-Host ("Codex exited with code {0}. Copy the error ABOVE this line and send it to the developer." -f $LASTEXITCODE) -ForegroundColor Red',
    '    }',
    '  } else {',
    '    Write-Host "Codex could not start. Copy the error above this line." -ForegroundColor Red',
    '  }',
    '} catch { Write-Host $_.Exception.Message -ForegroundColor Red }'
  ].join('\n');
  // Keep the shell alive even if Codex fails. Never use codex.exe as Windows' terminal shell.
  return { ...base,
    shellPath: path.win32.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    shellArgs: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', command]
  };
}
module.exports = { quotePowerShell, resumeLaunch };
