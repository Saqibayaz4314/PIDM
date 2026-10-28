$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $project 'bin'
$expected = '4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077'
$archive = Join-Path $directory 'ffmpeg-9.0.2-essentials_build.7z'
$executable = Join-Path $directory 'ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
  & curl.exe -4 -L --fail --silent --show-error --connect-timeout 20 --speed-time 30 --speed-limit 1024 --retry 3 --output "$archive.download" 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.7z'
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg download failed' }
  Move-Item -LiteralPath "$archive.download" -Destination $archive -Force
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'FFmpeg archive checksum mismatch' }
if (-not (Test-Path -LiteralPath $executable)) {
  & tar.exe -xf $archive -C $directory
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg extraction failed' }
}
& $executable -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg could not start' }
Write-Host 'FFmpeg 9.0.2 installed from the SHA-256-verified Gyan build linked by ffmpeg.org.'
