param([Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('vidence-install-' + [guid]::NewGuid().ToString('N'))
$previousAppData = $env:LOCALAPPDATA
try {
    $env:LOCALAPPDATA = $testRoot
    function Read-Host { return '2' }
    function Start-Process { param($FilePath, $ArgumentList) }
    function Set-Clipboard { param($Value) $script:copiedPath = $Value }
    $installer = (Get-ChildItem -LiteralPath $Package -Filter '*.ps1' -File | Select-Object -First 1).FullName
    . $installer
    $destination = Join-Path $testRoot 'VideoMemoryAssistant/browser-extension'
    if ($script:copiedPath -ne $destination) { throw 'Install path was not copied' }
    $manifest = Get-Content -LiteralPath (Join-Path $destination 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.manifest_version -ne 3) { throw 'Installed manifest is invalid' }
    $marker = Join-Path $testRoot 'VideoMemoryAssistant/learning-data-preserved.txt'
    Set-Content -LiteralPath $marker -Value 'preserve'
    . $installer
    if (-not (Test-Path -LiteralPath $marker)) { throw 'Update must preserve adjacent user data' }
    Write-Host 'EXTENSION_INSTALLER_PASS: stock Windows PowerShell, isolated install and update, no browser opened'
} finally {
    $env:LOCALAPPDATA = $previousAppData
    $resolved = [IO.Path]::GetFullPath($testRoot)
    if ($resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf).StartsWith('vidence-install-')) {
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}
