param(
  [switch]$SkipSelfTest,
  [string]$PkgTargets = "node18-win-x64,node16-win-x64"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$tsDir = Join-Path $root "ts-backend"
$distExe = Join-Path $root "dist/polymcp-inspector-backend.exe"
$staticSrc = Join-Path $root "polymcp_inspector/static"
$staticDist = Join-Path $root "dist/static"
$targetExe = Join-Path $root "desktop-tauri/src-tauri/bin/polymcp-inspector-backend-x86_64-pc-windows-msvc.exe"
$targetStatic = Join-Path $root "desktop-tauri/src-tauri/bin/static"

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
      # not ready yet
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Write-Host "Building TS backend..."
Set-Location $tsDir
npm install
npm run build

if (-not (Test-Path "node_modules/.bin/pkg.cmd")) {
  npm install --save-dev pkg
}

if (Test-Path $distExe) {
  Remove-Item $distExe -Force
}

Write-Host "Packaging TS backend to exe..."
$targets = $PkgTargets.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$packaged = $false
$lastErr = $null
foreach ($t in $targets) {
  Write-Host "Trying pkg target: $t"
  try {
    npm exec pkg -- dist/server.js --targets $t --output $distExe
    if (Test-Path $distExe) {
      $packaged = $true
      Write-Host "Packaged successfully with target: $t"
      break
    }
  } catch {
    $lastErr = $_
  }
}

if (-not $packaged) {
  if ($lastErr) {
    Write-Warning ("pkg error: " + $lastErr)
  }
  throw "Packaging failed for all targets: $PkgTargets"
}

if (-not (Test-Path $distExe)) {
  throw "Build failed: $distExe not found"
}

if (-not (Test-Path $staticSrc)) {
  throw "Missing static source folder: $staticSrc"
}

if (Test-Path $staticDist) {
  Remove-Item $staticDist -Recurse -Force
}
Copy-Item $staticSrc $staticDist -Recurse -Force

if (-not $SkipSelfTest) {
  $testPort = Get-Random -Minimum 20000 -Maximum 50000
  $testKey = "selftest-polymcp-ts-key"
  $testStateDir = Join-Path $root "dist/state"
  Write-Host "Self-test: launching TS backend exe on port $testPort"

  $previousStatic = $env:POLYMCP_INSPECTOR_STATIC_DIR
  $previousState = $env:POLYMCP_INSPECTOR_STATE_DIR
  $env:POLYMCP_INSPECTOR_STATIC_DIR = $staticDist
  New-Item -ItemType Directory -Force -Path $testStateDir | Out-Null
  $env:POLYMCP_INSPECTOR_STATE_DIR = $testStateDir
  $proc = Start-Process -FilePath $distExe `
    -ArgumentList @("--host","127.0.0.1","--port",$testPort,"--secure","--api-key",$testKey) `
    -PassThru
  try {
    $ok = Wait-BackendHealth -Port $testPort -ApiKey $testKey -TimeoutSeconds 120
    if (-not $ok) {
      throw "Self-test failed: TS backend exe did not become healthy within 120s"
    }
    Write-Host "TS backend self-test passed."
  } finally {
    if ($null -eq $previousStatic) {
      Remove-Item Env:POLYMCP_INSPECTOR_STATIC_DIR -ErrorAction SilentlyContinue
    } else {
      $env:POLYMCP_INSPECTOR_STATIC_DIR = $previousStatic
    }
    if ($null -eq $previousState) {
      Remove-Item Env:POLYMCP_INSPECTOR_STATE_DIR -ErrorAction SilentlyContinue
    } else {
      $env:POLYMCP_INSPECTOR_STATE_DIR = $previousState
    }
    $alive = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($alive) {
      Stop-Process -Id $proc.Id -Force
    }
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetExe) | Out-Null
Copy-Item $distExe $targetExe -Force

if (Test-Path $targetStatic) {
  Remove-Item $targetStatic -Recurse -Force
}
Copy-Item $staticDist $targetStatic -Recurse -Force

Write-Host "TS backend sidecar ready at: $targetExe"
Write-Host "TS backend static copied to: $targetStatic"
