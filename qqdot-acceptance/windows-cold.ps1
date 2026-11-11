$ErrorActionPreference = 'Stop'
$destination = 'C:\app'
foreach ($name in @('python', 'python3', 'pip', 'node', 'npm', 'uv')) {
    if (Get-Command $name -ErrorAction SilentlyContinue) { throw "Unexpected preinstalled runtime: $name" }
}
if (Test-Path -LiteralPath $destination) { throw 'Application directory was not initially absent' }
$result = @{ scope='Remote Windows Server Core container; no GUI desktop claim'; baselineNoPython=$true; baselineNoNode=$true; initiallyAbsent=$true }
function Install-App {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath 'C:\input\Setup.exe' -ArgumentList @('--silent','--destination',$destination,'--no-launch','--no-shortcut','--no-runtimes') -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(900000)) { $process.Kill(); throw 'Installer timed out' }
    if ($process.ExitCode -ne 0) { throw "Installer exit: $($process.ExitCode)" }
    return [math]::Round($watch.Elapsed.TotalSeconds, 2)
}
try {
    $result.firstInstallSeconds = Install-App
    $python = Join-Path $destination '.venv\Scripts\python.exe'
    & $python -X utf8 -c 'import sqlite3,ssl,ctypes; from PySide6 import QtWidgets; import qfluentwidgets,psutil,websockets,jsonschema,numpy,pypdf,ijson,qrcode,botpy,cryptography; print("runtime imports passed")' *> C:\evidence\imports.log
    if ($LASTEXITCODE -ne 0) { throw 'Actual installed runtime imports failed' }
    & $python -X utf8 C:\app\launcher.py --check > C:\evidence\startup.json
    if ($LASTEXITCODE -ne 0) { throw 'Startup check failed' }
    $startup = Get-Content C:\evidence\startup.json -Raw | ConvertFrom-Json
    if (-not $startup.ready -or $startup.model_requests -ne 0 -or $startup.starts_services) { throw 'Invalid startup report' }
    $launcher = Start-Process -FilePath C:\app\'Open QQ Dot.exe' -ArgumentList '--prepare-only' -WindowStyle Hidden -PassThru
    if (-not $launcher.WaitForExit(120000) -or $launcher.ExitCode -ne 0) { throw 'Thin launcher runtime check failed' }
    New-Item -ItemType Directory -Force C:\app\friends\12345,C:\app\data,C:\app\qq-runtime\state | Out-Null
    $sentinels = @('C:\app\friends\12345\synthetic-preservation.txt','C:\app\data\synthetic-login.txt','C:\app\qq-runtime\state\synthetic-session.txt')
    foreach ($path in $sentinels) { 'synthetic-state-must-survive' | Set-Content -LiteralPath $path }
    $hashes = @{}; foreach ($path in $sentinels) { $hashes[$path] = (Get-FileHash -LiteralPath $path).Hash }
    $result.repairSeconds = Install-App
    foreach ($path in $sentinels) { if ((Get-FileHash -LiteralPath $path).Hash -ne $hashes[$path]) { throw 'Private-state preservation failed' } }
    $result.syntheticPrivateStatePreserved = $true
    $result.success = $true
} catch {
    $result.success = $false
    $result.error = $_.Exception.Message
} finally {
    $result | ConvertTo-Json -Depth 6 | Set-Content C:\evidence\cold-install.json -Encoding UTF8
    if (Test-Path C:\app\installation.log) { Copy-Item C:\app\installation.log C:\evidence\installation.log }
    if (Test-Path C:\app\bootstrap-check.log) { Copy-Item C:\app\bootstrap-check.log C:\evidence\bootstrap-check.log }
}
if (-not $result.success) { exit 1 }
