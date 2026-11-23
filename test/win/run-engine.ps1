# 在 Windows 上验证「补丁引擎」本身：apply → verify(L1) → revert → 逐字节还原
#
#   .\test\win\run-engine.ps1            # 自建临时假宿主树，跑完删掉
#   .\test\win\run-engine.ps1 -Keep      # 保留临时目录排查
#
# 不需要预先准备 C:\purge-test：所有源码文件按补丁里的真实锚点现场生成，
# 只要机器上有 Node ≥18 和 python 3 就能跑（没有 python 也能跑，只是 L1 会少几项）。
param(
  [string]$WorkDir = (Join-Path $env:TEMP ('hp-engine-' + [guid]::NewGuid().ToString('N').Substring(0, 8))),
  [switch]$Keep
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = $WorkDir
$tree = Join-Path $root 'hermes-agent'
$fail = @()
function Check($name, [bool]$ok, $detail) {
  if ($ok) { Write-Host ("  OK   " + $name) -ForegroundColor Green }
  else { Write-Host ("  FAIL " + $name + "  " + $detail) -ForegroundColor Red; $script:fail += $name }
}

Write-Host '== 准备假宿主树（按真实锚点生成的 python 文件）=='
New-Item -ItemType Directory -Force -Path (Join-Path $tree 'tools'), (Join-Path $tree 'agent'), (Join-Path $tree 'acp_adapter'), (Join-Path $tree 'hermes_cli') | Out-Null

# C01：YOLO 标志常量
@'
import os

_YOLO_MODE_FROZEN: bool = is_truthy_value(os.getenv("HERMES_YOLO_MODE", ""))


def is_truthy_value(v: str) -> bool:
    return v.strip().lower() in {"1", "true", "yes", "on"}
'@ | Set-Content -Path (Join-Path $tree 'tools\approval.py') -Encoding UTF8

# C09 / C10：护栏决策
@'
class Decision:
    def __init__(self, action: str) -> None:
        self.action = action

    def allows_execution(self) -> bool:
        return self.action in {"allow", "warn"}

    def should_halt(self) -> bool:
        return self.action in {"block", "halt"}
'@ | Set-Content -Path (Join-Path $tree 'agent\tool_guardrails.py') -Encoding UTF8

# C07 / C08：编辑审批
@'
from typing import Any


class EditProposal:
    pass


def should_auto_approve_edit(proposal: EditProposal, policy: str, cwd: str | None = None) -> bool:
    return False


def maybe_require_edit_approval(tool_name: str, arguments: dict[str, Any]) -> str | None:
    return "ask"
'@ | Set-Content -Path (Join-Path $tree 'acp_adapter\edit_approval.py') -Encoding UTF8

Set-Content -Path (Join-Path $root 'config.yaml') -Value "model:`n  default: fake`n"
Set-Content -Path (Join-Path $root 'SOUL.md') -Value 'fake soul'
Set-Content -Path (Join-Path $root '.env') -Value ''

$files = @(
  (Join-Path $tree 'tools\approval.py'),
  (Join-Path $tree 'agent\tool_guardrails.py'),
  (Join-Path $tree 'acp_adapter\edit_approval.py')
)
$hashBefore = @{}
foreach ($f in $files) { $hashBefore[$f] = (Get-FileHash $f -Algorithm SHA256).Hash }

$py = (Get-Command python -ErrorAction SilentlyContinue)
if ($py) { $env:PY = $py.Source; Write-Host ("  python=" + $py.Source) }
else { Write-Host '  没有 python：AST 层会降级，L1 会少几项（不影响文本层结论）' }

Set-Location $repo

Write-Host '== status（未应用）=='
$st = & node bin/purge.js status --json --target=$tree 2>&1 | Out-String
Check 'status 可解析' ($LASTEXITCODE -eq 0) $st
$stRows = $st | ConvertFrom-Json
Check '初始 pending 存在' (($stRows.rows | Where-Object { $_.status -eq 'pending' }).Count -gt 0) ''

Write-Host '== apply =='
$ap = & node bin/purge.js apply --target=$tree 2>&1 | Out-String
$apc = $LASTEXITCODE
($ap -split "`r?`n" | Select-Object -Last 3) | ForEach-Object { Write-Host $_ }
Check 'apply 退出码 0' ($apc -eq 0) "exit=$apc"

Write-Host '== 确认真的改到了 =='
$yolo = (Select-String -Path $files[0] -Pattern '_YOLO_MODE_FROZEN: bool = True' -SimpleMatch | Measure-Object).Count
Check 'C01 常量已改' ($yolo -eq 1) $files[0]
# AST 层插入的 return 不带行尾注释，文本层才带 —— 两种都认，只看函数体第一行是不是 return True
$guard = (Select-String -Path $files[1] -Pattern '^\s+return True(\s+#.*)?$' | Measure-Object).Count
Check 'C09 护栏已放行' ($guard -ge 1) $files[1]
$edit = (Select-String -Path $files[2] -Pattern '^\s+return True(\s+#.*)?$' | Measure-Object).Count
Check 'C07 编辑审批已放行' ($edit -ge 1) $files[2]

Write-Host '== verify L1 =='
$vf = & node bin/purge.js verify --level=1 --target=$tree 2>&1 | Out-String
$vfc = $LASTEXITCODE
($vf -split "`r?`n" | Select-Object -Last 3) | ForEach-Object { Write-Host $_ }
Check 'verify L1 通过' ($vfc -eq 0) "exit=$vfc"

Write-Host '== revert =='
$rv = & node bin/purge.js revert --target=$tree 2>&1 | Out-String
$rvc = $LASTEXITCODE
($rv -split "`r?`n" | Select-Object -Last 2) | ForEach-Object { Write-Host $_ }
Check 'revert 退出码 0' ($rvc -eq 0) "exit=$rvc"

Write-Host '== 逐字节校验 =='
foreach ($f in $files) {
  $h = (Get-FileHash $f -Algorithm SHA256).Hash
  Check ((Split-Path $f -Leaf) + ' 还原一致') ($h -eq $hashBefore[$f]) 'sha256 不一致'
}

Set-Location $repo
if (-not $Keep) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host ("临时目录保留：$root") }

Write-Host ''
if ($fail.Count) { Write-Host ("ENGINE_FAIL=" + ($fail -join ' / ')) -ForegroundColor Red; exit 1 }
Write-Host 'ENGINE_OK' -ForegroundColor Green
