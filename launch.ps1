$ErrorActionPreference = 'Stop'
$node = 'D:\client\IDM-Project\tools\node-v24.22.1\node.exe'
$server = Join-Path $PSScriptRoot 'src\server.js'
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not (Test-Path -LiteralPath $node)) { throw 'Node.js 24 is missing' }
$process = Start-Process -FilePath $node -ArgumentList @($server) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
if ($process.HasExited) { throw 'Downloader server did not start; port 17341 may be occupied' }
if ($edge) { Start-Process -FilePath $edge -ArgumentList '--app=http://127.0.0.1:17341/' }
else { Start-Process 'http://127.0.0.1:17341/' }
Write-Host "Personal Downloader is running (PID $($process.Id)). Close it with Stop-Process -Id $($process.Id)."
