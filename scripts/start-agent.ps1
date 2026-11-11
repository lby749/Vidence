$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$state = Join-Path $root '.local-agent'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$bridge = Join-Path $PSScriptRoot 'local-agent-bridge.mjs'
$tokenPath = Join-Path $state 'token'
function Test-Bridge {
  if (!(Test-Path -LiteralPath $tokenPath)) { return $false }
  $pairingToken = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
  try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:8131/health' -Headers @{ Authorization = "Bearer $pairingToken" } -TimeoutSec 2; return $true } catch { return $false }
}
if (!(Test-Bridge)) {
  Start-Process -FilePath 'node' -ArgumentList @('"' + $bridge + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $state 'bridge.log') -RedirectStandardError (Join-Path $state 'bridge-error.log')
}
for ($i = 0; $i -lt 30 -and !(Test-Bridge); $i++) { Start-Sleep -Milliseconds 250 }
if (!(Test-Bridge)) { throw '本地桥接未就绪，请检查 .local-agent/bridge-error.log' }
(Get-Content -Raw -LiteralPath $tokenPath).Trim() | Set-Clipboard
Write-Host '本地智能体桥接已启动，连接令牌已复制。'
Write-Host '在视频侧边栏点击“选择智能体”，粘贴令牌并连接测试。'
