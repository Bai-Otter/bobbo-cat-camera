$ErrorActionPreference = 'Stop'
$mukbangStudioRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$mukbangStudioPython = Join-Path $mukbangStudioRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $mukbangStudioPython)) {
    python -m venv (Join-Path $mukbangStudioRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Python virtual environment.' }
}
& $mukbangStudioPython -m pip install -r (Join-Path $mukbangStudioRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; the service was not started.' }
Push-Location -LiteralPath $mukbangStudioRoot
try { & $mukbangStudioPython 'run.py' --port 8876 }
finally { Pop-Location }
