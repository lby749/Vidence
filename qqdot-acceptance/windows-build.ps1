$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$project = Join-Path $env:GITHUB_WORKSPACE 'Open-QQ-Dot'
$evidence = Join-Path $env:GITHUB_WORKSPACE 'evidence-windows'
New-Item -ItemType Directory -Force $evidence | Out-Null
Set-Location -LiteralPath $project
python -m venv .venv
$python = Join-Path $project '.venv\Scripts\python.exe'
& $python -m pip install uv
$uv = Join-Path $project '.venv\Scripts\uv.exe'
& $uv pip install --python $python -r requirements-ui-core.txt pytest pytest-subtests PyInstaller -r requirements-browser-optional.txt
& $uv pip install --python $python --no-deps -r requirements-ui-qfluent.txt
& $python -m playwright install chromium
$env:PATH = (Join-Path $project '.venv\Scripts') + ';' + $env:PATH
$env:QT_QPA_PLATFORM = 'offscreen'
$env:PYTHONUTF8 = '1'
& $python -X utf8 launcher.py --check > (Join-Path $evidence 'startup.json')
& $uv pip list --python $python > (Join-Path $evidence 'python-packages.txt')
$PSNativeCommandUseErrorActionPreference = $false
& $python -X utf8 -m pytest -q tests --junitxml="$evidence/full.xml" --basetemp="$env:RUNNER_TEMP/qqdot-tests" *> (Join-Path $evidence 'full.log')
$testCode = $LASTEXITCODE
$testCode | Set-Content (Join-Path $evidence 'test-exit.txt')
Get-Content (Join-Path $evidence 'full.log') -Tail 70
$PSNativeCommandUseErrorActionPreference = $true
& ./tools/build_windows_exe.ps1
& $python -X utf8 tools/build_windows_installer.py
$installer = Join-Path $project 'dist/Open QQ Dot Setup.exe'
Get-FileHash -Algorithm SHA256 -LiteralPath $installer | ConvertTo-Json | Set-Content (Join-Path $evidence 'installer-sha256.json')
New-Item -ItemType Directory -Force (Join-Path $env:GITHUB_WORKSPACE 'installer') | Out-Null
Copy-Item -LiteralPath $installer -Destination (Join-Path $env:GITHUB_WORKSPACE 'installer/Setup.exe')
