# Dot-source this file to keep child-process caches and temporary files in this project.
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:TEMP = Join-Path $projectRoot '.local\tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $projectRoot '.local\npm-cache'
$env:PYTHONPYCACHEPREFIX = Join-Path $projectRoot '.local\pycache'
New-Item -ItemType Directory -Force -Path $env:TEMP, $env:npm_config_cache, $env:PYTHONPYCACHEPREFIX | Out-Null
