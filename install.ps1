<#
  hermes-purge 一键安装（Windows / PowerShell）

    .\install.ps1                  # 装到 %LOCALAPPDATA%\hermes-purge，并建 purge / hp 命令
    .\install.ps1 -Uninstall       # 删掉命令与目录
    .\install.ps1 -Dest D:\purge   # 指定目录
    .\install.ps1 -Bin  D:\bin     # 命令装到别处（默认 %LOCALAPPDATA%\hermes-purge\bin）

  只做三件事：确认 Node ≥18、把仓库放到固定位置、在 bin 目录里写两个 .cmd shim。
  不改宿主、不写系统目录、不需要管理员权限。
#>
param(
  [switch]$Uninstall,
  # 装完直接跑 purge setup（等价于 POSIX 的 --setup）；-Yes 表示不问确认
  [switch]$Setup,
  [switch]$Yes,
  [string]$Dest = (Join-Path $env:LOCALAPPDATA 'hermes-purge'),
  [string]$Bin  = (Join-Path $env:LOCALAPPDATA 'hermes-purge\bin'),
  [string]$Repo = 'https://github.com/XiaoBinGan/hermes-purge.git',
  # 脚本不是从仓库里跑的时候，从 Release 下源码包（公开资产，不需要登录）
  [string]$Version = 'latest',
  # 镜像/代理（GitHub 直连不稳时用）：默认官方，可换 https://ghproxy.com/https://github.com/XiaoBinGan/hermes-purge
  [string]$BaseUrl = 'https://github.com/XiaoBinGan/hermes-purge'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
# Windows PowerShell 5.1 默认还可能走 TLS 1.0；GitHub 只收 1.2+，不设会「基础连接已经关闭」
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$ProgressPreference = 'SilentlyContinue'

function Say($m)  { Write-Host $m }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Die($m)  { Write-Host $m -ForegroundColor Red; exit 1 }

if ($Uninstall) {
  foreach ($c in 'purge.cmd','hp.cmd','_hermes-purge-launch.js','_hermes-purge-home.json') {
    $p = Join-Path $Bin $c
    if (Test-Path $p) { Remove-Item $p -Force; Say "已移除 $p" }
  }
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force; Say "已删除 $Dest" }
  Say '宿主上的补丁不会因此消失；要撤销补丁用：purge revert'
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die ' 找不到 node。先装 Node.js ≥18：https://nodejs.org/' }
# 注意：PowerShell 5.1 会把传给原生程序的参数里的双引号吃掉，所以别用 node -p "..." 带引号的表达式
$nv = (& node -v).Trim()
$major = [int]($nv.TrimStart('v').Split('.')[0])
if ($major -lt 18) { Die "Node 版本太低（$(& node -v)）。需要 ≥18。" }

$Src = $PSScriptRoot
if (Test-Path (Join-Path $Src 'bin\purge.js')) {
  Say "使用当前目录：$Src"
  if ((Resolve-Path $Src).Path -ne (Resolve-Path $Dest -ErrorAction SilentlyContinue).Path) {
    if (Test-Path $Dest) { Warn "$Dest 已存在，保留原样" } else {
      New-Item -ItemType Directory -Path (Split-Path $Dest) -Force | Out-Null
      Copy-Item $Src $Dest -Recurse -Force
      Say "已复制到 $Dest"
    }
  }
} else {
  # 没有仓库（例如直接下载 install.ps1 跑的）：下 Release 源码包，公开资产，无需登录
  $gh = $BaseUrl.TrimEnd('/')
  if ($Version -eq 'latest') { $url = "$gh/releases/latest/download/hermes-purge-src.zip" }
  else { $url = "$gh/releases/download/v$($Version.TrimStart('v'))/hermes-purge-src.zip" }
  $tmpZip = Join-Path ([IO.Path]::GetTempPath()) ("hp-src-" + [Guid]::NewGuid().ToString('N') + ".zip")
  $tmpDir = Join-Path ([IO.Path]::GetTempPath()) ("hp-src-" + [Guid]::NewGuid().ToString('N'))
  Say "下载源码包：$url"
  $dlErr = $null
  try {
    Invoke-WebRequest $url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 120
  } catch { $dlErr = $_.Exception.Message }
  if ($dlErr -or -not (Test-Path $tmpZip) -or (Get-Item $tmpZip).Length -eq 0) {
    # PS 5.1 在某些网络下 IWR 直接断连；退到系统自带的 curl.exe（Win10 1803+ 都有）
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      Say '  IWR 失败，改用 curl.exe 重试'
      & curl.exe -fsSL --retry 3 --connect-timeout 20 $url -o $tmpZip
      if ($LASTEXITCODE -ne 0) { Die "下载失败：$url（curl 退出码 $LASTEXITCODE；可用 -BaseUrl 换镜像）" }
    } else {
      Die "下载失败：$url（$dlErr；可用 -BaseUrl 换镜像，或手动下载后在本目录跑 ./install.sh）"
    }
  }
  Expand-Archive $tmpZip -DestinationPath $tmpDir -Force
  $srcDir = Get-ChildItem $tmpDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'bin\purge.js') } | Select-Object -First 1
  if (-not $srcDir) { Die '包结构不对：里面没有 bin/purge.js' }
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $Dest -Force | Out-Null
  Copy-Item (Join-Path $srcDir.FullName '*') $Dest -Recurse -Force
  Remove-Item $tmpZip, $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  # package.json 是 UTF-8：PS 5.1 的 Get-Content 默认按 ANSI 读会乱码，必须显式 UTF-8
  $installed = $Version
  try { $installed = ([IO.File]::ReadAllText((Join-Path $Dest 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json).version } catch { }
  Say "已安装到 $Dest（版本 $installed，无需登录）"
}

New-Item -ItemType Directory -Path $Bin -Force | Out-Null

# ── 启动器：.cmd 里绝不出现真实路径 ────────────────────────────────────────
# 坑：路径带中文/日文/俄文时，Set-Content -Encoding ASCII 会把它们写成 "?"，
# 而 cmd.exe 又按 OEM 代码页（中文 Windows 是 936）解析批处理，UTF-8 也救不回来。
# 结果就是 node 收到 "G:\??????????\...\purge.js" → MODULE_NOT_FOUND。
# 解法：.cmd 只有纯 ASCII 的相对调用（%~dp0 在运行时展开，走的是 UTF-16），
# 真实路径写进 UTF-8 的 JSON，由 Node 启动器读（Node 收命令行参数永远是 Unicode）。
$homeJson = Join-Path $Bin '_hermes-purge-home.json'
$launcher = Join-Path $Bin '_hermes-purge-launch.js'
$launcherJs = @'
'use strict';
// install.ps1 生成的启动器（纯 ASCII 源码）。
// 真实安装路径在同目录 _hermes-purge-home.json —— 这样 .cmd 不用写非 ASCII 路径。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = path.join(__dirname, '_hermes-purge-home.json');
let home;
try {
  home = JSON.parse(fs.readFileSync(cfg, 'utf8')).home;
} catch (e) {
  console.error('[hermes-purge] 读不到安装位置：' + cfg + '（重跑 install.ps1）');
  process.exit(1);
}
const cmd = process.argv[2];
const entry = path.join(home, 'bin', cmd + '.js');
const r = spawnSync(process.execPath, [entry].concat(process.argv.slice(3)), { stdio: 'inherit' });
if (r.error) {
  console.error('[hermes-purge] 启动失败：' + (r.error.message || r.error));
  process.exit(1);
}
process.exit(typeof r.status === 'number' ? r.status : 1);
'@
[IO.File]::WriteAllText($launcher, $launcherJs, (New-Object Text.UTF8Encoding($false)))
# JSON 里用正斜杠：Windows 路径不含双引号，这样不用处理反斜杠转义
$homeJsonText = '{"home": "' + $Dest.Replace('\', '/') + '"}'
[IO.File]::WriteAllText($homeJson, $homeJsonText, (New-Object Text.UTF8Encoding($false)))

foreach ($c in 'purge','hp') {
  $cmdPath = Join-Path $Bin ($c + '.cmd')
  $body = "@echo off`r`nnode `"%~dp0_hermes-purge-launch.js`" $c %*`r`n"
  Set-Content -Path $cmdPath -Value $body -Encoding ASCII -NoNewline
  Say "已安装命令：$cmdPath"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -split ';' -notcontains $Bin) {
  Warn "注意：$Bin 不在用户 PATH 里。把下面一行加到 PATH（或重启终端后手动加）："
  Warn "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$Bin', 'User')"
}

if ($Setup -or $Yes) {
  Say ''
  Say '—— 装完了，直接跑 purge setup ——'
  $env:PATH = "$Bin;$env:PATH"
  $setupArgs = @((Join-Path $Dest 'bin\purge.js'), 'setup')
  if ($Yes) { $setupArgs += '--yes' }
  & node @setupArgs
  exit $LASTEXITCODE
}

Say ''
Say '下一步（一条命令，检测 → 计划 → 应用 → 验证）：'
Say '  purge setup'
