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
  [string]$Repo = 'https://github.com/XiaoBinGan/hermes-purge.git'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Say($m)  { Write-Host $m }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Die($m)  { Write-Host $m -ForegroundColor Red; exit 1 }

if ($Uninstall) {
  foreach ($c in 'purge.cmd','hp.cmd') {
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
  if (Test-Path (Join-Path $Dest '.git')) {
    Say "更新 $Dest"
    & git -C $Dest pull --ff-only | Out-Null
  } else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die ' 没有 git，且不是从仓库里跑的：请先 git clone。' }
    & git clone --depth 1 $Repo $Dest | Out-Null
    Say "已克隆到 $Dest"
  }
}

New-Item -ItemType Directory -Path $Bin -Force | Out-Null
foreach ($c in 'purge','hp') {
  $cmdPath = Join-Path $Bin ($c + '.cmd')
  $body = "@echo off`r`nnode `"$Dest\bin\$c.js`" %*`r`n"
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
