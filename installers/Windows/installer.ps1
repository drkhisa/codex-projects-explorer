# Codex Projects Explorer installer. No administrator rights or policy changes required.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$root = $env:CODEX_INSTALLER_DIR
if (-not $root) { throw 'Не найдена папка установщика. Запустите Установить.cmd из распакованного архива.' }
$metadata = Get-Content -LiteralPath ([IO.Path]::Combine($root, 'installer.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
$script:CodeExecutable = $null
$script:CodeTarget = $null
$script:ProbeLog = New-Object System.Collections.Generic.List[string]
$script:Installing = $false
$script:Installed = $false

function Resolve-Code([string]$candidate) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
    $candidate = [IO.Path]::GetFullPath($candidate)
    $directory = [IO.Path]::GetDirectoryName($candidate)
    $name = [IO.Path]::GetFileName($candidate)
    $script:ProbeLog.Add('Проверка: ' + $candidate)
    if ($name -in @('code.cmd', 'code-insiders.cmd')) {
        $parent = Split-Path $directory -Parent
        $exe = [IO.Path]::Combine($parent, 'Code.exe')
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { $exe = [IO.Path]::Combine($parent, 'Code - Insiders.exe') }
        if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { $exe = $null }
        return [pscustomobject]@{ CodeExecutable = $exe; Cli = $candidate; Mode = 'cmd'; Directory = $directory }
    }
    if ($name -notin @('Code.exe', 'Code - Insiders.exe')) { return $null }
    foreach ($base in @($directory, (Split-Path $directory -Parent))) {
        if (-not $base) { continue }
        $wrappers = @('bin\code.cmd', 'bin\code-insiders.cmd')
        if ($name -eq 'Code - Insiders.exe') { $wrappers = @('bin\code-insiders.cmd', 'bin\code.cmd') }
        foreach ($relative in $wrappers) {
            $cli = [IO.Path]::Combine($base, $relative)
            $script:ProbeLog.Add('CLI: ' + $cli)
            if (Test-Path -LiteralPath $cli -PathType Leaf) { return [pscustomobject]@{ CodeExecutable = $candidate; Cli = $cli; Mode = 'cmd'; Directory = $base } }
        }
        foreach ($relative in @('resources\app\out\cli.js', 'resources\app\out\cli.cjs', 'resources\app\out\vs\code\node\cli.js')) {
            $cli = [IO.Path]::Combine($base, $relative)
            $script:ProbeLog.Add('CLI: ' + $cli)
            if (Test-Path -LiteralPath $cli -PathType Leaf) { return [pscustomobject]@{ CodeExecutable = $candidate; Cli = $cli; Mode = 'node'; Directory = $base } }
        }
    }
    return $null
}
function Find-Code {
    $candidates = @()
    # The editor is already running for this installation flow. Its actual path is
    # more reliable than any assumed layout under AppData or Program Files.
    foreach ($process in @(Get-Process -Name 'Code', 'Code - Insiders' -ErrorAction SilentlyContinue)) {
        try { if ($process.Path) { $candidates += $process.Path } } catch { }
    }
    foreach ($rootKey in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Code.exe')) {
        try { $key = Get-Item -LiteralPath $rootKey -ErrorAction SilentlyContinue; if ($key) { $value = $key.GetValue(''); if ($value) { $candidates += $value } } } catch { }
    }
    if ($env:LOCALAPPDATA) { $candidates += [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') }
    foreach ($programs in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($programs) { $candidates += [IO.Path]::Combine($programs, 'Microsoft VS Code', 'Code.exe') }
    }
    foreach ($commandName in @('code.cmd', 'code-insiders.cmd')) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($command) { $candidates += $command.Source }
    }
    foreach ($candidate in @($candidates | Select-Object -Unique)) { $target = Resolve-Code $candidate; if ($target) { return $target } }
    return $null
}
function Quote-Argument([string]$value, [bool]$forCmd = $false) {
    if ($value.IndexOf('"') -ge 0 -or $value -match '[\x00-\x1f]') { throw 'Недопустимые символы в пути.' }
    if ($forCmd -and $value.Contains('%')) { throw 'Путь содержит знак %. Перенесите распакованный установщик в папку без знака % или выберите Code.exe с доступным JS-компонентом.' }
    return '"' + $value + '"'
}
function Run-CodeCli($target, [string[]]$arguments) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    if ($target.Mode -eq 'cmd') {
        $start.FileName = [IO.Path]::Combine($env:SystemRoot, 'System32\cmd.exe')
        $parts = @($target.Cli) + $arguments | ForEach-Object { Quote-Argument $_ $true }
        $start.Arguments = '/d /v:off /s /c "' + ($parts -join ' ') + '"'
    } else {
        $start.FileName = $target.CodeExecutable
        $start.Arguments = ((@($target.Cli) + $arguments | ForEach-Object { Quote-Argument $_ }) -join ' ')
        $start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
    }
    $start.WorkingDirectory = $target.Directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.EnvironmentVariables.Remove('VSCODE_DEV')
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    while (-not $process.HasExited) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
    $process.WaitForExit()
    $result = [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.Result + [Environment]::NewLine + $stderr.Result }
    $process.Dispose()
    return $result
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Установка Codex Projects Explorer'
$form.Size = New-Object System.Drawing.Size(690, 490)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Codex Projects Explorer ' + $metadata.version + ' · установщик r2'
$heading.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$heading.SetBounds(24, 20, 630, 42)
$form.Controls.Add($heading)
$intro = New-Object System.Windows.Forms.Label
$intro.Text = "Проекты и полноценный чат Codex в центре VS Code.`nНажмите «Установить» — расширение установится автоматически."
$intro.SetBounds(26, 70, 620, 52)
$form.Controls.Add($intro)
$pathLabel = New-Object System.Windows.Forms.Label
$pathLabel.Text = 'Найденный VS Code:'
$pathLabel.SetBounds(26, 130, 590, 24)
$form.Controls.Add($pathLabel)
$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.ReadOnly = $true
$pathBox.SetBounds(26, 158, 510, 29)
$form.Controls.Add($pathBox)
$browse = New-Object System.Windows.Forms.Button
$browse.Text = 'Выбрать…'
$browse.SetBounds(546, 156, 110, 32)
$form.Controls.Add($browse)
$status = New-Object System.Windows.Forms.Label
$status.SetBounds(26, 202, 625, 46)
$status.Text = 'Готово к установке.'
$form.Controls.Add($status)
$progress = New-Object System.Windows.Forms.ProgressBar
$progress.SetBounds(26, 252, 630, 12)
$progress.Style = 'Marquee'
$progress.Visible = $false
$form.Controls.Add($progress)
$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.SetBounds(26, 278, 630, 105)
$log.Text = 'Установщик использует VS Code, уже установленный на этом компьютере. Исходники ваших проектов и чаты Codex он не меняет.'
$form.Controls.Add($log)
$install = New-Object System.Windows.Forms.Button
$install.Text = 'Установить'
$install.SetBounds(386, 400, 150, 38)
$form.Controls.Add($install)
$close = New-Object System.Windows.Forms.Button
$close.Text = 'Закрыть'
$close.SetBounds(546, 400, 110, 38)
$form.Controls.Add($close)
$form.AcceptButton = $install
$close.Add_Click({ $form.Close() })
$form.Add_FormClosing({ param($sender, $eventArgs) if ($script:Installing) { $eventArgs.Cancel = $true; $status.Text = 'Дождитесь завершения установки.' } })
$script:CodeTarget = Find-Code
if ($script:CodeTarget) {
    $script:CodeExecutable = $script:CodeTarget.CodeExecutable
    $pathBox.Text = $script:CodeTarget.Cli
    $log.Text = 'Найден CLI VS Code: ' + $script:CodeTarget.Cli + "`r`nСпособ запуска: " + $script:CodeTarget.Mode
} else {
    $pathBox.Text = 'VS Code не найден'; $status.Text = 'Откройте VS Code и перезапустите установщик либо выберите Code.exe / code.cmd.'; $install.Enabled = $false
    $log.Text = $script:ProbeLog -join "`r`n"
}
$browse.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Выберите Code.exe или bin\code.cmd из папки VS Code'
    $dialog.Filter = 'Visual Studio Code|Code.exe;Code - Insiders.exe;code.cmd;code-insiders.cmd|Все файлы|*.*'
    if ($dialog.ShowDialog() -eq 'OK') {
        $target = Resolve-Code $dialog.FileName
        if ($target) {
            $script:CodeTarget = $target; $script:CodeExecutable = $target.CodeExecutable; $pathBox.Text = $target.Cli; $install.Enabled = $true; $status.Text = 'Готово к установке.'
            $log.Text = 'Выбран CLI: ' + $target.Cli + "`r`nСпособ запуска: " + $target.Mode
        } else {
            $log.Text = 'Выбран файл: ' + $dialog.FileName + "`r`n" + ($script:ProbeLog -join "`r`n")
            [void][System.Windows.Forms.MessageBox]::Show(('Не найден штатный CLI рядом с выбранным файлом:' + "`r`n" + $dialog.FileName + "`r`n`r`nВыберите bin\code.cmd из папки VS Code. Проверенные пути показаны внизу установщика."), 'Не найден CLI VS Code')
        }
    }
    $dialog.Dispose()
})
$install.Add_Click({
    if ($script:Installed) { if ($script:CodeExecutable) { Start-Process -FilePath $script:CodeExecutable }; $form.Close(); return }
    $script:Installing = $true; $install.Enabled = $false; $browse.Enabled = $false; $close.Enabled = $false; $progress.Visible = $true
    try {
        $status.Text = 'Устанавливаю расширение…'
        [System.Windows.Forms.Application]::DoEvents()
        $vsix = [IO.Path]::Combine($root, $metadata.vsix)
        if (-not (Test-Path -LiteralPath $vsix -PathType Leaf)) { throw 'Файл расширения не найден. Сначала полностью распакуйте архив установщика.' }
        if ((Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash -ne $metadata.sha256) { throw 'Файл расширения повреждён. Скачайте архив заново.' }
        $result = Run-CodeCli $script:CodeTarget @('--install-extension', $vsix, '--force')
        $log.Text = $result.Output
        if ($result.ExitCode -ne 0) { throw ('VS Code не завершил установку. Код: ' + $result.ExitCode + '. Подробности в поле ниже.') }
        $status.Text = 'Проверяю установленную версию…'
        $verify = Run-CodeCli $script:CodeTarget @('--list-extensions', '--show-versions')
        $expected = '(?im)^' + [regex]::Escape($metadata.extensionId + '@' + $metadata.version) + '\s*$'
        if ($verify.ExitCode -ne 0 -or $verify.Output -notmatch $expected) { throw 'VS Code не подтвердил нужную версию расширения. Проверьте вывод установки ниже.' }
        $script:Installed = $true
        $status.Text = 'Установлено. Закройте и снова откройте VS Code, если он уже запущен.'
        if ($script:CodeExecutable) { $install.Text = 'Открыть VS Code' } else { $install.Text = 'Готово' }
        $log.AppendText("`r`nВерсия " + $metadata.version + " подтверждена. Слева в VS Code появится значок «Проекты Codex».")
    } catch {
        $status.Text = 'Установка не завершена.'
        $log.AppendText("`r`n" + $_.Exception.Message)
    } finally {
        $script:Installing = $false; $progress.Visible = $false; $install.Enabled = $true; $close.Enabled = $true; $browse.Enabled = -not $script:Installed
    }
})
[void]$form.ShowDialog()
$form.Dispose()
