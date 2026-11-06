@echo off
setlocal DisableDelayedExpansion
set "CODEX_INSTALLER_DIR=%~dp0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -Command "$p=[IO.Path]::Combine($env:CODEX_INSTALLER_DIR,'installer.ps1'); & ([scriptblock]::Create([IO.File]::ReadAllText($p)))"
if errorlevel 1 (
  echo.
  echo Installer could not start. Keep all extracted files in one folder.
  pause
)
endlocal
