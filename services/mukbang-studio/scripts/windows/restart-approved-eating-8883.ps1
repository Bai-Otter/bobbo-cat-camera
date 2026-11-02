# Run manually in PowerShell. Codex has not executed this script.
# Restricted to the existing local 8883 daily-photo-gallery service.
$ErrorActionPreference = 'Stop'
$serviceRoot = 'E:/AI/bobbo-cat-camera-dual-videos/services/mukbang-studio'
$servicePython = 'E:/AI/bobbo-mukbang-studio/.venv/Scripts/python.exe'
$dataRoot = Join-Path $serviceRoot 'data/daily-photo-gallery'
$baseUrl = 'http://127.0.0.1:8883'

function Get-LocalJson {
    param([string]$Uri, [int]$TimeoutSec = 10)
    # Windows PowerShell 5.1 guesses a legacy encoding for application/json
    # without charset. Decode JSON bytes explicitly so Chinese labels compare.
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec $TimeoutSec
    $json = [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
    return ($json | ConvertFrom-Json)
}

if (-not (Test-Path -LiteralPath $servicePython)) { throw 'Service Python not found.' }
$preflightText = & $servicePython -X utf8 (Join-Path $serviceRoot 'scripts/check_story_runtime.py') --data-dir $dataRoot --expected-ai-model gpt-6.1-sol
if ($LASTEXITCODE -ne 0) { throw 'AI/narration preflight failed. Existing service was NOT stopped.' }
$preflight = ($preflightText -join "`n") | ConvertFrom-Json
if (-not $preflight.ai_configured) { throw 'AI is not configured. Nothing was stopped.' }
Write-Host ($preflight | ConvertTo-Json -Depth 6 -Compress)
$before = $preflight.story_production_profile
$listener = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 8883 })
$expected = '*run_daily.py --port 8883 --data-dir data/daily-photo-gallery*'
if ($listener.Count) {
    if ($listener.Count -ne 1 -or $listener[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected listener; nothing stopped.' }
    $jobs = Get-LocalJson -Uri "$baseUrl/api/jobs" -TimeoutSec 10
    $active = @($jobs.jobs | Where-Object { $_.status -notin @('completed','failed','cancelled','interrupted') })
    if ($active.Count) { throw 'A generation is still running. Nothing was stopped. Retry when it finishes.' }
    $before = (Get-LocalJson -Uri "$baseUrl/api/config" -TimeoutSec 10).story_production_profile
    $worker = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener[0].OwningProcess)
    $launcher = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $worker.ParentProcessId)
    if ($worker.CommandLine -notlike $expected -or $launcher.CommandLine -notlike $expected) { throw 'Unexpected process; nothing stopped.' }
    if ($launcher.ExecutablePath -ne $servicePython.Replace('/', '\')) { throw 'Unexpected Python launcher; nothing stopped.' }
    Stop-Process -Id $worker.ProcessId -ErrorAction Stop
    if (Get-Process -Id $launcher.ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $launcher.ProcessId -ErrorAction Stop }
} else {
    $pending = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like $expected })
    if ($pending.Count) { throw 'Service process exists without a listener. Inspect it before starting a duplicate.' }
    Write-Host 'Service is stopped; starting it with verified saved settings.'
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$serviceProcess = Start-Process -FilePath $servicePython -ArgumentList '-X','utf8','run_daily.py','--port','8883','--data-dir','data/daily-photo-gallery' -WorkingDirectory $serviceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot "manual-restart-$stamp.out.log") -RedirectStandardError (Join-Path $dataRoot "manual-restart-$stamp.err.log") -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
        $null = Get-LocalJson -Uri "$baseUrl/api/eating-music" -TimeoutSec 2
        $ready = $true
        break
    } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) { throw "Service not ready. Check $dataRoot/manual-restart-$stamp.err.log" }

& $servicePython -X utf8 (Join-Path $serviceRoot 'scripts/install_approved_eating_music.py') --source-directory 'E:/AI/outputs/user-picked-bgm-2026-11-02' --destination (Join-Path $dataRoot 'music-eating') --local-preview-only
if ($LASTEXITCODE -ne 0) { throw 'Audio installation failed. The previous library remains active.' }
$pool = Get-LocalJson -Uri "$baseUrl/api/eating-music" -TimeoutSec 10
if ($pool.count -ne 4 -or $pool.version -ne 'cat-eating-approved-four-v1' -or $pool.mode -ne 'random_per_job' -or -not $pool.enabled) { throw 'Live library verification failed.' }
$live = Get-LocalJson -Uri "$baseUrl/api/config" -TimeoutSec 10
if (-not $live.configured -or -not $live.provider.key_configured) { throw 'Live AI configuration is missing. Do not generate yet.' }
foreach ($property in @('base_url','model','api_style','configuration_source','client_compatibility','timeout_seconds')) {
    if ($live.provider.$property -ne $preflight.provider.$property) { throw "Live AI configuration mismatch: $property. Do not generate yet." }
}
$after = $live.story_production_profile
foreach ($property in @('version','style_version','voice_label','voice_kind','bgm_enabled','music_mode','music_library_version','music_track_count')) {
    if ($before.$property -ne $after.$property) { throw "Story configuration changed: $property. Please report this before generating." }
}
if ($after.narration_enabled -ne $true) { throw 'Narration was not restored. Please report this before generating.' }
Write-Host 'SUCCESS: four approved tracks are active; new eating videos select one randomly.' -ForegroundColor Green
Write-Host 'Story narration is enabled; confirmed voice and story music are unchanged.'
Write-Host 'AI is configured: gpt-6.1-sol; saved provider settings verified (no paid API probe).'
Write-Host "$baseUrl/daily"
