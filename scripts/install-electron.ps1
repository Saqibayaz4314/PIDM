$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$package = Join-Path $project 'node_modules\electron'
$version = (Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw | ConvertFrom-Json).version
$binary = Join-Path $package 'dist\electron.exe'
if (Test-Path -LiteralPath $binary) { Write-Host "Electron $version is installed."; exit 0 }

$archiveName = "electron-v$version-win32-x64.zip"
$release = "https://github.com/electron/electron/releases/download/v$version"
$cache = Join-Path $project 'node_modules\.cache\electron'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$archive = Join-Path $cache $archiveName
$checksums = Join-Path $cache "SHASUMS256-v$version.txt"

& curl.exe -L --fail --retry 3 --continue-at - --output $archive "$release/$archiveName"
if ($LASTEXITCODE -ne 0) { throw 'Electron archive download failed' }
& curl.exe -L --fail --silent --show-error --output $checksums "$release/SHASUMS256.txt"
if ($LASTEXITCODE -ne 0) { throw 'Electron checksum download failed' }
$line = Get-Content -LiteralPath $checksums | Where-Object { $_.EndsWith("*$archiveName") } | Select-Object -First 1
if (-not $line) { throw 'Electron archive checksum was not published' }
$expected = $line.Substring(0, 64).ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Electron archive checksum mismatch: $actual" }

$destination = Join-Path $package 'dist'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
& tar.exe -xf $archive -C $destination
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $binary)) { throw 'Electron extraction failed' }
Set-Content -LiteralPath (Join-Path $package 'path.txt') -Value 'electron.exe' -NoNewline
Remove-Item -LiteralPath $archive, $checksums -Force
Write-Host "Electron $version installed and SHA-256 verified."
