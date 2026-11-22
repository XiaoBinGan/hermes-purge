<#
  windows-smoke.ps1 —— 在任意 Windows 机器/VM 上一条命令跑完验收

    .\windows-smoke.ps1            # 跑全部
    .\windows-smoke.ps1 -Keep      # 保留临时目录（排查用）

  做的事：单元测试 → npm 打包自检 → install.ps1 装到临时目录 → purge --version/--help
  → 假 Hermes 树上的 setup --dry / 非交互拒绝写入 / uninstall → CRLF 保真。
  不联网（除 npm 自身解析外），不碰你真实的 Hermes 安装。
#>
param([switch]$Keep)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp  = Join-Path $env:TEMP ('hp-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$script:failed = @()
function Step($name, [scriptblock]$body) {
  Write-Host "`n== $name" -ForegroundColor Cyan
  try { & $body; Write-Host "   OK" -ForegroundColor Green }
  catch { Write-Host "   FAIL: $($_.Exception.Message)" -ForegroundColor Red; $script:failed += $name }
}

Push-Location $root
try {
  Step 'node / python' {
    Write-Host ("   node " + (node -v)); Write-Host ("   python " + (python --version 2>&1))
  }

  Step '单元测试' {
    foreach ($t in 'test/smoke.js','test/v2.js','test/dsh.js','test/setup.js','test/bench.js') {
      node $t
      if ($LASTEXITCODE -ne 0) { throw "$t 退出码 $LASTEXITCODE" }
    }
  }

  Step 'npm 打包自检' {
    node test/package.js
    if ($LASTEXITCODE -ne 0) { throw "test/package.js 退出码 $LASTEXITCODE" }
  }

  Step 'install.ps1 安装 + 可用' {
    $dest = Join-Path $tmp 'hp-install'; $bin = Join-Path $tmp 'hp-bin'
    & (Join-Path $root 'install.ps1') -Dest $dest -Bin $bin
    $cmd = Join-Path $bin 'purge.cmd'
    if (-not (Test-Path $cmd)) { throw '没生成 purge.cmd' }
    $v = (& $cmd --version).Trim()
    $want = (node -p "require('./package.json').version").Trim()
    if ($v -ne $want) { throw "版本不一致：$v vs $want" }
    & $cmd --help | Select-Object -First 3 | Out-Host
    Write-Host "   purge --version = $v"
  }

  Step '假 Hermes 树：setup --dry / 非交互拒绝 / uninstall' {
    $tree = Join-Path $tmp 'hermes-agent'
    New-Item -ItemType Directory -Force -Path (Join-Path $tree 'hermes_cli'), (Join-Path $tree 'agent') | Out-Null
    Set-Content -Path (Join-Path $tmp 'config.yaml') -Value "model:`n  default: fake"
    Set-Content -Path (Join-Path $tmp 'SOUL.md') -Value 'fake'
    node bin/purge.js setup --dry --target=$tree | Select-Object -First 6 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "setup --dry 退出码 $LASTEXITCODE" }

    $out = node bin/purge.js setup --target=$tree 2>&1 | Out-String
    if ($LASTEXITCODE -ne 1) { throw "无 --yes 时应退出 1，实际 $LASTEXITCODE`n$out" }
    if ($out -notmatch '--yes') { throw "没提示 --yes：`n$out" }

    node bin/purge.js uninstall --yes --target=$tree | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "uninstall 退出码 $LASTEXITCODE" }
  }

  Step 'CRLF 保真' {
    $d = Join-Path $tmp 'crlf'; New-Item -ItemType Directory -Force -Path $d | Out-Null
    $f = Join-Path $d 'x.py'
    [IO.File]::WriteAllText($f, "def f():`r`n    return 1`r`n")
    node -e "const p=require('./lib/v2/platform');const r=p.readText(process.argv[1]);p.writeText(process.argv[1],'def f():\n    return 2',{eol:r.eol,bom:r.bom})" $f
    $raw = [IO.File]::ReadAllText($f)
    if ($raw -notmatch "`r`n") { throw 'CRLF 丢了' }
    if ($raw -match "[^`r]`n") { throw '混进了裸 LF' }
  }
}
finally { Pop-Location }

Write-Host ''
if ($script:failed.Count) {
  Write-Host ("失败 " + $script:failed.Count + " 项：" + ($script:failed -join ' / ')) -ForegroundColor Red
  exit 1
}
Write-Host 'Windows 验收全绿' -ForegroundColor Green
if (-not $Keep) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "临时目录保留在 $tmp" }
