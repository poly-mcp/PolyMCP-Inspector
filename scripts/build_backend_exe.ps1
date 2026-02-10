param(
  [string]$PythonExe = "python",
  [switch]$SkipSelfTest
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Stop-LockingProcesses {
  param(
    [string[]]$TargetPaths
  )

  # Stop common app/backend processes first
  $names = @("polymcp-inspector-backend", "PolyMCP Inspector")
  foreach ($n in $names) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
      try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {}
    }
  }

  # Stop any process currently running one of the target exe paths
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    try {
      if ($p.Path -and ($TargetPaths -contains $p.Path)) {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
      }
    } catch {}
  }
}

function Remove-FileWithRetry {
  param(
    [string]$Path,
    [int]$Retries = 12,
    [int]$DelayMs = 800
  )
  if (-not (Test-Path $Path)) { return }

  for ($i = 1; $i -le $Retries; $i++) {
    try {
      Remove-Item $Path -Force -ErrorAction Stop
      return
    } catch {
      if ($i -eq $Retries) {
        throw "Unable to remove locked file: $Path"
      }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Wait-BackendHealth {
  param(
    [int]$Port,
    [string]$ApiKey,
    [int]$TimeoutSeconds = 120
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) `
        -Headers @{ "X-Inspector-API-Key" = $ApiKey } `
        -UseBasicParsing -TimeoutSec 2
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        return $true
      }
    } catch {
      # Not ready yet
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$venvDir = Join-Path $root ".venv-backend-build"
$venvPy = Join-Path $venvDir "Scripts/python.exe"

if (-not (Test-Path $venvPy)) {
  Write-Host "Creating isolated build venv at $venvDir"
  & $PythonExe -m venv $venvDir
}

Write-Host "Installing build dependencies in isolated venv..."
& $venvPy -m pip install --upgrade pip setuptools wheel
& $venvPy -m pip install pyinstaller fastapi uvicorn httpx requests
& $venvPy -m pip install -e .

try {
  $distExePath = (Resolve-Path "dist/polymcp-inspector-backend.exe" -ErrorAction SilentlyContinue).Path
  $binExePath = (Resolve-Path "desktop-tauri/src-tauri/bin/polymcp-inspector-backend-x86_64-pc-windows-msvc.exe" -ErrorAction SilentlyContinue).Path
  $targetExePath = (Resolve-Path "desktop-tauri/src-tauri/target/release/polymcp-inspector-backend.exe" -ErrorAction SilentlyContinue).Path
  $paths = @($distExePath, $binExePath, $targetExePath) | Where-Object { $_ }
  Stop-LockingProcesses -TargetPaths $paths
} catch {}

if (Test-Path "build/polymcp-inspector-backend") {
  Remove-Item "build/polymcp-inspector-backend" -Recurse -Force
}
Remove-FileWithRetry -Path "dist/polymcp-inspector-backend.exe"

$pyinstallerArgs = @(
  "--paths", $root,
  "--noconfirm",
  "--clean",
  "--noupx",
  "--onefile",
  "--noconsole",
  "--name", "polymcp-inspector-backend",
  "--collect-all", "fastapi",
  "--collect-all", "uvicorn",
  "--collect-all", "httpx",
  "--collect-all", "requests",
  "--add-data", "polymcp_inspector/static;polymcp_inspector/static",
  "--collect-submodules", "polymcp_inspector",
  "--hidden-import", "polymcp_inspector.server",
  "scripts/inspector_entry.py"
)

Write-Host "Building backend sidecar exe..."
& $venvPy -m PyInstaller @pyinstallerArgs

$builtExe = Join-Path $root "dist/polymcp-inspector-backend.exe"
if (-not (Test-Path $builtExe)) {
  throw "Build failed: $builtExe not found"
}

if (-not $SkipSelfTest) {
  $testPort = Get-Random -Minimum 20000 -Maximum 50000
  $testKey = "selftest-polymcp-key"
  Write-Host "Self-test: launching backend exe on port $testPort"
  $proc = Start-Process -FilePath $builtExe `
    -ArgumentList @("--host","127.0.0.1","--port",$testPort,"--secure","--api-key",$testKey,"--no-browser") `
    -PassThru
  try {
    $ok = Wait-BackendHealth -Port $testPort -ApiKey $testKey -TimeoutSeconds 120
    if (-not $ok) {
      throw "Self-test failed: backend exe did not become healthy within 120s"
    }
    Write-Host "Self-test passed."
  } finally {
    $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($alive) {
      Stop-Process -Id $proc.Id -Force
    }
  }
}

$target = "desktop-tauri/src-tauri/bin/polymcp-inspector-backend-x86_64-pc-windows-msvc.exe"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
Copy-Item $builtExe $target -Force

Write-Host "Backend sidecar ready at: $target"
