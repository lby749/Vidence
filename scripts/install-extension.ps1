$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'extension'
if (-not (Test-Path -LiteralPath (Join-Path $sourcePath 'manifest.json'))) { throw '请完整解压插件包，再运行安装。' }
$destinationPath = Join-Path $env:LOCALAPPDATA 'VideoMemoryAssistant/browser-extension'
New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null
Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $destinationPath -Recurse -Force
Write-Host 'Vidence 浏览器插件 · BETA'
Write-Host '1. Microsoft Edge    2. Google Chrome'
$selection = Read-Host '选择浏览器（默认 1）'
if ($selection -eq '2') { $browserName = 'chrome.exe'; $extensionsPage = 'chrome://extensions/' }
else { $browserName = 'msedge.exe'; $extensionsPage = 'edge://extensions/' }
$browserPath = $null
foreach ($key in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$browserName", "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\$browserName")) {
    if (Test-Path -LiteralPath $key) { $candidate = (Get-ItemProperty -LiteralPath $key).'(default)'; if (Test-Path -LiteralPath $candidate) { $browserPath = $candidate; break } }
}
if ($browserPath) { Start-Process -FilePath $browserPath -ArgumentList $extensionsPage }
else { Write-Host "请在浏览器地址栏打开 $extensionsPage" }
Set-Clipboard -Value $destinationPath
Write-Host '在扩展页面开启“开发人员模式”，点“加载解压缩的扩展”，粘贴已复制的路径。'
Write-Host $destinationPath
Write-Host '更新已安装的插件后，点击扩展页面的“重新加载”。学习数据保存在原浏览器，不会随本脚本删除。'
