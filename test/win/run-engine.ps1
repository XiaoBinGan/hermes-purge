# 在 Windows 上验证「补丁引擎」本身：真实源码文件 → apply → verify(L1) → revert → 逐字节还原
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = 'C:\purge-test\host'
$tree = "$root\hermes-agent"
$repo = 'C:\purge-test\hermes-purge'

Write-Host '== 准备假宿主树（真实源码文件 + 可用的 python）=='
New-Item -ItemType Directory -Force -Path "$tree\tools","$tree\agent\transports","$tree\acp_adapter","$tree\hermes_cli","$tree\venv\Scripts" | Out-Null
Copy-Item 'C:\purge-test\py\*' "$tree\venv\Scripts\" -Recurse -Force
Set-Content -Path "$root\config.yaml" -Value "model:`n  default: fake`n"
Set-Content -Path "$root\SOUL.md" -Value 'fake soul'
Set-Content -Path "$root\.env" -Value ''

$files = @(
  @{ src = 'src\tools\approval.py';        dst = "$tree\tools\approval.py" },
  @{ src = 'src\agent\tool_guardrails.py'; dst = "$tree\agent\tool_guardrails.py" },
  @{ src = 'src\acp_adapter\edit_approval.py'; dst = "$tree\acp_adapter\edit_approval.py" }
)
foreach ($f in $files) {
  $p = Join-Path 'C:\purge-test' $f.src
  if (Test-Path $p) { Copy-Item $p $f.dst -Force; Write-Host ("  复制 " + $f.dst) }
}
$hashBefore = @{}
foreach ($f in $files) { $hashBefore[$f.dst] = (Get-FileHash $f.dst -Algorithm SHA256).Hash }

Set-Location $repo
$env:PATH = "C:\purge-test\node\node-v22.11.0-win-arm64;C:\purge-test\py;$env:PATH"

Write-Host '== status =='
node bin/purge.js status --target=$tree 2>&1 | Select-Object -First 6 | ForEach-Object { Write-Host $_ }
Write-Host '== apply =='
$ap = & node bin/purge.js apply --target=$tree 2>&1; $apc = $LASTEXITCODE
$ap | Select-Object -Last 4 | ForEach-Object { Write-Host $_ }
Write-Host "APPLY_EXIT=$apc"
Write-Host '== verify L1 =='
$vf = & node bin/purge.js verify --level=1 --target=$tree 2>&1; $vfc = $LASTEXITCODE
$vf | Select-Object -Last 3 | ForEach-Object { Write-Host $_ }
Write-Host "VERIFY_EXIT=$vfc"
Write-Host '== 确认真的改到了（第一行插入）=='
$patched = Select-String -Path "$tree\tools\approval.py" -Pattern '_YOLO_MODE_FROZEN' -SimpleMatch | Select-Object -First 1
Write-Host ("  " + $patched.Line.Trim())
Write-Host '== revert =='
$rv = & node bin/purge.js revert --target=$tree 2>&1; $rvc = $LASTEXITCODE
$rv | Select-Object -Last 3 | ForEach-Object { Write-Host $_ }
Write-Host "REVERT_EXIT=$rvc"
Write-Host '== 逐字节校验 =='
$same = $true
foreach ($f in $files) {
  $h = (Get-FileHash $f.dst -Algorithm SHA256).Hash
  $eq = $h -eq $hashBefore[$f.dst]
  if (-not $eq) { $same = $false }
  Write-Host ("  " + (Split-Path $f.dst -Leaf) + " 还原一致=" + $eq)
}
Write-Host ("RESTORE_IDENTICAL=" + $same)
