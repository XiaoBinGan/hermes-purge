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
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
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
    Write-Host ("   node " + (node -v))
    # python 只对 purge 的 L2 断言有用；没有就说明一句，不算失败
    $pyv = try { (& python --version 2>&1) -join ' ' } catch { '' }
    if ($pyv -match 'Python \d') { Write-Host "   python $pyv" }
    else { Write-Host '   python 未安装（L2 断言/部分 bench 用例会跳过，不影响其余）' }
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
    # 别用 node -p "require(...)"：PS5.1 吃掉双引号会炸；直接读 package.json
    # PS 5.1 的 Get-Content 默认按 ANSI 解码：package.json 是 UTF-8 且带中文，直接读会乱码
    $want = ([IO.File]::ReadAllText((Join-Path $root 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json).version.Trim()
    if ($v -ne $want) { throw "版本不一致：$v vs $want" }
    & $cmd --help | Select-Object -First 3 | Out-Host
    Write-Host "   purge --version = $v"
  }

  Step '中文 / 带空格路径安装（.cmd 不得写非 ASCII 路径）' {
    $h = Join-Path $tmp '中文 目录\安装 位置'
    $dest3 = Join-Path $h 'hermes-purge'; $bin3 = Join-Path $h 'bin'
    & (Join-Path $root 'install.ps1') -Dest $dest3 -Bin $bin3
    $cmd3 = Join-Path $bin3 'purge.cmd'
    $shim = [IO.File]::ReadAllText($cmd3)
    if ($shim -match '[^\x00-\x7F]') { throw ".cmd 里有非 ASCII 字符：$shim" }
    if ($shim.Contains($dest3)) { throw '.cmd 里写死了安装路径' }
    $v3 = (& $cmd3 --version).Trim()
    if ($v3 -notmatch '^\d+\.\d+\.\d+$') { throw "中文路径下 purge --version 失败：$v3" }
    Write-Host "   中文路径 → purge --version = $v3"
  }

  Step 'install.ps1 -Setup -Yes（一条命令装完即应用）' {
    $h = Join-Path $tmp 'oneshot'
    $dest2 = Join-Path $h 'app'; $bin2 = Join-Path $h 'bin'
    $tree2 = Join-Path $h 'host\hermes-agent'
    New-Item -ItemType Directory -Force -Path (Join-Path $tree2 'hermes_cli'), (Join-Path $tree2 'agent') | Out-Null
    Set-Content -Path (Join-Path $h 'host\config.yaml') -Value "model:`n  default: fake"
    $env:HERMES_HOME = Join-Path $h 'host'
    $o = & (Join-Path $root 'install.ps1') -Dest $dest2 -Bin $bin2 -Setup -Yes 2>&1 | Out-String
    $code = $LASTEXITCODE
    $env:HERMES_HOME = $null
    if ($o -notmatch 'purge setup') { throw "没有跑到 purge setup：$o" }
    if ($o -notmatch 'cap\s+\d+ 条') { throw "setup 没打印 cap 统计：$o" }
    Write-Host "   install.ps1 -Setup -Yes → exit=$code（假宿主下 apply 会跳过不可用项，属预期）"
    if (-not (Test-Path (Join-Path $bin2 'purge.cmd'))) { throw '没装出 purge.cmd' }
  }

  Step '假 Hermes 树：setup --dry / 非交互拒绝 / uninstall' {
    $tree = Join-Path $tmp 'hermes-agent'
    New-Item -ItemType Directory -Force -Path (Join-Path $tree 'hermes_cli'), (Join-Path $tree 'agent') | Out-Null
    Set-Content -Path (Join-Path $tmp 'config.yaml') -Value "model:`n  default: fake"
    Set-Content -Path (Join-Path $tmp 'SOUL.md') -Value 'fake'
    # 注意：不要 `node ... | Select-Object -First N` —— 管道被提前关闭会把 node 掐掉，退出码头 -1
    $dryOut = & node bin/purge.js setup --dry --target=$tree 2>&1
    $dryCode = $LASTEXITCODE
    $dryOut | Select-Object -First 6 | ForEach-Object { Write-Host $_ }
    if ($dryCode -ne 0) { throw "setup --dry 退出码 $dryCode" }

    $out = (node bin/purge.js setup --target=$tree 2>&1 | Out-String)
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
