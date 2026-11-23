$ErrorActionPreference = 'Continue'
$root = 'C:\purge-test'
Set-Location $root
Expand-Archive "$root\repo.zip" -DestinationPath $root -Force
Expand-Archive "$root\node.zip" -Destination "$root\node" -Force
$env:PATH = "$root\node\node-v22.11.0-win-arm64;$root\py;$env:PATH"
Write-Output ("NODE=" + (& node -v))
Write-Output ("NPM=" + (& npm -v))
Set-Location "$root\hermes-purge"
& powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-smoke.ps1
Write-Output ("SMOKE_EXIT=" + $LASTEXITCODE)
