$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$vsluaRoot = $PSScriptRoot
$solution = Join-Path $vsluaRoot 'src\\DebugAdapter\\DebugAdapter.sln'

if (-not (Test-Path $solution)) {
  throw "Missing solution: $solution"
}

Write-Host "Building DebugAdapter (Release)..." -ForegroundColor Cyan

msbuild $solution /t:Restore,Build /p:RestorePackagesConfig=true /p:Configuration=Release /p:Platform="Any CPU" /m

if ($LASTEXITCODE -ne 0) {
  throw "msbuild failed with exit code $LASTEXITCODE"
}

$expected = @(
  (Join-Path $vsluaRoot 'DebugAdapter.exe'),
  (Join-Path $vsluaRoot 'Newtonsoft.Json.dll'),
  (Join-Path $vsluaRoot 'GiderosPlayerRemote.dll')
)

$missing = @($expected | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
  throw ("Build succeeded but expected output file(s) missing:`n" + ($missing -join "`n"))
}

Write-Host "OK: updated vslua runtime binaries" -ForegroundColor Green
