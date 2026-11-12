param([Parameter(Mandatory=$true)][string]$Package,[Parameter(Mandatory=$true)][string]$Media)
$ErrorActionPreference='Stop'
$packagePath=(Resolve-Path -LiteralPath $Package).Path
$workspacePath=(Get-Location).Path
$mediaPath=(Resolve-Path -LiteralPath $Media).Path
$components=Join-Path $env:RUNNER_TEMP 'vidence-journey-ai'
$node=Join-Path $packagePath '_internal/runtime/node.exe'
& $node scripts/prepare-journey-ai.mjs $components
if ($LASTEXITCODE -ne 0) { throw 'Pinned vision test component download failed' }
$runtime=Join-Path $components 'runtime'
if (-not (Test-Path -LiteralPath $runtime)) {
    Expand-Archive -LiteralPath (Join-Path $components 'llama-b11597-bin-win-cpu-x64.zip') -DestinationPath $runtime
}
$serverFile=Get-ChildItem -LiteralPath $runtime -Filter llama-server.exe -Recurse | Select-Object -First 1
if (-not $serverFile) { throw 'Vision test runtime is incomplete' }
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
$evidence=Join-Path $workspacePath 'artifacts/cloud-journey'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$state=Join-Path ([IO.Path]::GetTempPath()) ('vidence-journey-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $state | Out-Null
$originalPath=$env:PATH
try {
    # The VL model and generic ChatML templates omit tool definitions. Use the
    # pinned upstream Qwen tool template; image controls must still prove pixels.
    $serverArguments=@('--host','127.0.0.1','--port',"$port",'--model',('"'+(Join-Path $components 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf')+'"'),'--mmproj',('"'+(Join-Path $components 'mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf')+'"'),'--alias','vidence-cloud-vision','--ctx-size','8192','--n-predict','512','--parallel','1','--threads','3','--gpu-layers','0','--jinja','--chat-template-file',('"'+(Join-Path $components 'Qwen-Qwen2.5-7B-Instruct.jinja')+'"'),'--image-min-tokens','1024','--temp','0')
    $env:PATH=Join-Path $env:SystemRoot 'System32'
    Remove-Item Env:PYTHONHOME,Env:PYTHONPATH,Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    if ((Get-Command python -ErrorAction SilentlyContinue) -or (Get-Command node -ErrorAction SilentlyContinue)) { throw 'System development runtimes remain reachable' }
    $server=Start-Process -FilePath $serverFile.FullName -ArgumentList $serverArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $evidence 'model-output.log') -RedirectStandardError (Join-Path $evidence 'model-error.log')
    $ready=$false
    for ($attempt=0;$attempt -lt 120;$attempt++) {
        if ($server.HasExited) { throw 'Pinned vision model server exited before readiness' }
        try { $health=Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2; if ($health.status -eq 'ok') {$ready=$true;break} } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'Real vision model did not become ready' }
    $env:VMA_STATE_DIR=$state;$env:QT_QPA_PLATFORM='offscreen'
    foreach ($phase in @('record','restart')) {
        $report=Join-Path $evidence ($phase+'.json')
        $plan=Join-Path $state 'journey-plan.json'
        @{ phase=$phase;report=$report;baseUrl="http://127.0.0.1:$port/v1";model='vidence-cloud-vision';media=@((Join-Path $mediaPath 'ocean.mp4'),(Join-Path $mediaPath 'forest.mp4')) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $plan -Encoding utf8NoBOM
        $env:VMA_JOURNEY_PLAN=$plan
        $launcher=Start-Process -FilePath (Join-Path $packagePath '一键启动.exe') -WindowStyle Hidden -PassThru
        if (-not $launcher.WaitForExit(30000) -or $launcher.ExitCode -ne 0) { throw 'One-click launcher did not finish normally' }
        $result=$null;$deadline=[DateTime]::UtcNow.AddMinutes(25)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $report) {
                try { $result=Get-Content -LiteralPath $report -Raw | ConvertFrom-Json; if ($result.terminal) {break} } catch {}
            }
            Start-Sleep -Milliseconds 500
        }
        if (-not $result.terminal) { throw 'Frozen full journey timed out' }
        $application=Get-Process -Id $result.processId -ErrorAction SilentlyContinue
        if ($application) {
            if ($application.Path -ne (Join-Path $packagePath 'Vidence.exe')) { throw 'Unexpected acceptance process' }
            if (-not $application.WaitForExit(30000)) { $application.Kill();throw 'Acceptance app did not close' }
        }
        if (-not $result.passed -or -not $result.realModel) { throw ('Frozen journey failed: '+$result.error) }
        Write-Output ("FROZEN_REAL_MODEL_JOURNEY_PASS "+$phase)
    }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id }
    $env:PATH=$originalPath
}
