$ErrorActionPreference = 'Stop'
$version = '2026.10.21'
$expected = '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555'
$project = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $project 'bin'
$binary = Join-Path $directory 'yt-dlp.exe'
New-Item -ItemType Directory -Path $directory -Force | Out-Null

if (-not (Test-Path -LiteralPath $binary)) {
  $url = "https://github.com/yt-dlp/yt-dlp/releases/download/$version/yt-dlp.exe"
  & curl.exe -L --fail --retry 3 --output $binary $url
  if ($LASTEXITCODE -ne 0) { throw 'yt-dlp download failed' }
}
$actual = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "yt-dlp checksum mismatch: $actual" }
Write-Host "yt-dlp $version installed and SHA-256 verified."
