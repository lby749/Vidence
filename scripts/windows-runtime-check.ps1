param([Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference = 'Stop'
$packagePath = (Resolve-Path -LiteralPath $Package).Path
$workspacePath = (Get-Location).Path
$reportPath = Join-Path $workspacePath 'artifacts/cloud-runtime.json'
New-Item -ItemType Directory -Force -Path (Split-Path $reportPath) | Out-Null
$inventory = @{ python = [bool](Get-Command python -ErrorAction SilentlyContinue); node = [bool](Get-Command node -ErrorAction SilentlyContinue) }
$originalPath = $env:PATH
$originalAppData = $env:LOCALAPPDATA
try {
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    $env:LOCALAPPDATA = Join-Path $env:RUNNER_TEMP 'video-memory-clean-runtime'
    $env:QT_QPA_PLATFORM = 'offscreen'
    Remove-Item Env:PYTHONHOME,Env:PYTHONPATH,Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    if ((Get-Command python -ErrorAction SilentlyContinue) -or (Get-Command node -ErrorAction SilentlyContinue)) { throw 'System development runtimes remain reachable' }
    $launcher = Start-Process -FilePath (Join-Path $packagePath '一键启动.exe') -ArgumentList @('--self-check', ('"' + $reportPath + '"')) -WindowStyle Hidden -PassThru
    if (-not $launcher.WaitForExit(60000)) { $launcher.Kill(); throw 'Frozen launcher timed out' }
    if ($launcher.ExitCode -ne 0) { throw 'Frozen launcher self-check failed' }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if (-not ($report.passed -and $report.frozen -and $report.nativePlaybackAndWebBindingsImported)) { throw 'Frozen bindings were not verified' }
    & (Join-Path $packagePath '_internal/runtime/node.exe') (Join-Path $workspacePath 'scripts/packaged-bridge-check.mjs') (Join-Path $packagePath '_internal')
    if ($LASTEXITCODE -ne 0) { throw 'Bundled bridge failed' }
    $report | Add-Member -NotePropertyName cleanHostedRunner -NotePropertyValue ($env:GITHUB_ACTIONS -eq 'true')
    $report | Add-Member -NotePropertyName preinstalledDeveloperTools -NotePropertyValue $inventory
    $report | Add-Member -NotePropertyName systemRuntimesOnTargetPath -NotePropertyValue $false
    $report | Add-Member -NotePropertyName physicallyEmptyWindows -NotePropertyValue $false
    $report | Add-Member -NotePropertyName missingWebViewInstallTested -NotePropertyValue $false
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
} finally {
    $env:PATH = $originalPath
    $env:LOCALAPPDATA = $originalAppData
}
