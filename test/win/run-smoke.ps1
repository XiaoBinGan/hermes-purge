# 在任意 Windows 上跑完整验收：.	estwinun-smoke.ps1
# （以前这脚本写死了 C:\purge-test + repo.zip，只有那台 VM 能跑）
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
Write-Output ("NODE=" + (& node -v))
Write-Output ("NPM=" + (& npm -v))
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'windows-smoke.ps1')
$code = $LASTEXITCODE
Write-Output ("SMOKE_EXIT=" + $code)
exit $code
