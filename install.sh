#!/usr/bin/env bash
# hermes-purge 一键安装（macOS / Linux / Windows 上的 bash）
#
#   ./install.sh                 # 装到 ~/.hermes-purge，并建 purge / hp 两个命令
#   ./install.sh --setup         # 装完直接跑 purge setup（一条命令装好）
#   ./install.sh --setup --yes   # 同上，但不问确认（脚本/CI 用）
#   ./install.sh --uninstall     # 删掉命令与目录
#   ./install.sh --relink        # 强制把 ~/.hermes-purge 重建成指向当前 checkout 的链接
#   HERMES_PURGE_HOME=... ./install.sh
#   HERMES_PURGE_BIN=...  ./install.sh      # 命令装到别处（默认 ~/.local/bin）
#   ./install.sh --base-url=https://mirror.example/hermes-purge   # 用镜像下源码包
#   ./install.sh --no-path                # 不自动改 shell rc（默认会写一行 PATH）
#
# 只做三件事：确认 Node ≥18、把仓库放到固定位置、在 PATH 里留两个 shim。
# 不改宿主、不写系统目录、不需要 sudo。
#
# Windows（Git Bash / MSYS2 / Cygwin）上：仓库位置用「目录联接」（mklink /J，不需要管理员），
# 命令写成纯 ASCII 的 .cmd 启动器 —— Git Bash 的 bash 脚本 PowerShell/cmd 跑不了，
# 而且 .cmd 里写中文路径会被 ASCII 编码毁成 "?"，所以真实路径放在 UTF-8 的 JSON 里。
set -euo pipefail

REPO="${HERMES_PURGE_REPO:-https://github.com/XiaoBinGan/hermes-purge.git}"
GH="${HERMES_PURGE_BASE_URL:-${HERMES_PURGE_GH:-https://github.com/XiaoBinGan/hermes-purge}}"
VERSION="${HERMES_PURGE_VERSION:-latest}"
DEST="${HERMES_PURGE_HOME:-$HOME/.hermes-purge}"
BIN="${HERMES_PURGE_BIN:-$HOME/.local/bin}"
MODE=install
DO_SETUP="${HERMES_PURGE_SETUP:-0}"
DO_YES=0
NO_PATH=0
RELINK=0

for a in "$@"; do
  case "$a" in
    --uninstall|-u) MODE=uninstall ;;
    --setup) DO_SETUP=1 ;;
    --yes|-y) DO_SETUP=1; DO_YES=1 ;;
    --relink) RELINK=1 ;;
    --home=*) DEST="${a#*=}" ;;
    --version=*) VERSION="${a#*=}" ;;
    --base-url=*) GH="${a#*=}" ;;
    --no-path) NO_PATH=1 ;;
    --bin=*)  BIN="${a#*=}" ;;
    -h|--help)
      sed -n '2,/^set -euo pipefail/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
      exit 0 ;;
    *) echo "未知参数：$a（--help 看用法）" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── 平台判定：MINGW*/MSYS*/CYGWIN* = 在 Windows 上跑 bash ──────────────────
IS_WIN=0
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;;
esac

# Git Bash 的 /c/Users/... 要换成 C:\Users\... 才能交给 cmd.exe / Node 之外的 Windows 程序
winpath() {
  if [ "$IS_WIN" = 1 ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

# 是不是链接/联接（Windows 上 dir /AL 只列 reparse point；父目录里按名字精确匹配）
is_reparse() {
  [ -e "$1" ] || return 1
  [ "$IS_WIN" = 1 ] || return 1
  local pdir pname
  pdir="$(dirname "$1")"
  pname="$(basename "$1")"
  MSYS_NO_PATHCONV=1 cmd /c dir /AL /B "$(winpath "$pdir")" 2>/dev/null \
    | tr -d '\r' | grep -Fxi -- "$pname" >/dev/null 2>&1
}

# 目录联接：不需要管理员，权限与普通目录一致；rmdir 只删链接、不动被指向的源码
link_win() {
  MSYS_NO_PATHCONV=1 cmd /c mklink /J "$(winpath "$1")" "$(winpath "$2")" >/dev/null 2>&1
}

if [ "$MODE" = uninstall ]; then
  rm -f "$BIN/purge" "$BIN/hp" "$BIN/purge.cmd" "$BIN/hp.cmd" \
        "$BIN/_hermes-purge-launch.js" "$BIN/_hermes-purge-home.json"
  say "已移除命令：$BIN/purge · $BIN/hp"
  if is_reparse "$DEST"; then
    MSYS_NO_PATHCONV=1 cmd /c rmdir "$(winpath "$DEST")" >/dev/null 2>&1 || true
    say "已移除目录联接 $DEST"
  elif [ -L "$DEST" ]; then
    rm -f "$DEST"
    say "已移除链接 $DEST"
  elif [ -d "$DEST" ]; then
    rm -rf "$DEST"
    say "已删除 $DEST"
  fi
  say "宿主上的补丁不会因此消失；要撤销补丁用：purge revert（或先装回来再 revert）"
  exit 0
fi

command -v node >/dev/null 2>&1 || die "找不到 node。先装 Node.js ≥18：https://nodejs.org/"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本太低（$((node -v))）。需要 ≥18。"

SRC="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SRC/bin/purge.js" ]; then
  # 从仓库里直接跑：链接到当前 checkout，改代码即时生效
  mkdir -p "$(dirname "$DEST")"
  if [ "$IS_WIN" = 1 ]; then
    if is_reparse "$DEST"; then
      say "已链接 $DEST → $SRC（目录联接已存在）"
    elif [ -e "$DEST" ]; then
      if [ "$RELINK" = 1 ]; then
        rm -rf "$DEST"
        link_win "$DEST" "$SRC" || die "建目录联接失败：$(winpath "$DEST") → $(winpath "$SRC")"
        say "已重建目录联接 $DEST → $SRC"
      else
        warn "检测到 $DEST 已存在且不是链接。"
        warn "  旧版 install.sh 在 Windows 上会把 ln -s 退化成「复制」，改仓库代码不会生效。"
        warn "  重建目录联接：$0 --relink   （会删掉这个副本；源码在你的仓库里，删了不心疼）"
        warn "  现在继续用这个副本装命令 —— 它里面的代码可能是旧的。"
      fi
    else
      link_win "$DEST" "$SRC" || die "建目录联接失败：$(winpath "$DEST") → $(winpath "$SRC")"
      say "已建目录联接 $DEST → $SRC（改代码即时生效）"
    fi
  elif [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    warn "$DEST 已存在且不是链接，保留原样、改用其中内容"
  else
    ln -sfn "$SRC" "$DEST"
    say "已链接 $DEST → $SRC"
  fi
else
  # 没有仓库（例如 curl | bash 下载的脚本）：直接下 Release 里的源码包。
  # Release 资产是公开的 —— 不需要任何登录、不需要 GitHub 账号、不需要 token。
  if [ "$VERSION" = "latest" ]; then
    SRC_URL="$GH/releases/latest/download/hermes-purge-src.tar.gz"
  else
    SRC_URL="$GH/releases/download/v${VERSION#v}/hermes-purge-src.tar.gz"
  fi
  TMPD="$(mktemp -d)"
  trap 'rm -rf "$TMPD"' EXIT
  say "下载源码包：$SRC_URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 20 "$SRC_URL" -o "$TMPD/src.tar.gz" \
      || die "下载失败：$SRC_URL（可用 --base-url=URL 换镜像）"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMPD/src.tar.gz" "$SRC_URL" \
      || die "下载失败：$SRC_URL（可用 --base-url=URL 换镜像）"
  else
    die "既没有 curl 也没有 wget。请手动下载 $SRC_URL 解开后，在目录里跑 ./install.sh"
  fi
  tar xzf "$TMPD/src.tar.gz" -C "$TMPD" || die "解压失败（包损坏？）"
  SRC_DIR="$(find "$TMPD" -maxdepth 1 -type d -name 'hermes-purge-*' | head -1)"
  [ -n "$SRC_DIR" ] || die "包结构不对：里面没有 hermes-purge-* 目录"
  [ -f "$SRC_DIR/bin/purge.js" ] || die "包结构不对：没有 bin/purge.js"
  if is_reparse "$DEST"; then
    MSYS_NO_PATHCONV=1 cmd /c rmdir "$(winpath "$DEST")" >/dev/null 2>&1 || true
  fi
  mkdir -p "$DEST"
  # 复制内容（保留 .git 之类不存在的也无所谓）
  cp -R "$SRC_DIR"/. "$DEST"/
  say "已安装到 $DEST（版本 ${VERSION}，无需登录）"
fi

mkdir -p "$BIN"
if [ "$IS_WIN" = 1 ]; then
  # .cmd 只能是纯 ASCII：中文/日文安装目录写进去会被 Set-Content/ASCII 或 OEM 代码页毁成 "?"
  WIN_DEST="$(winpath "$DEST")"
  cat > "$BIN/_hermes-purge-launch.js" <<'JS'
'use strict';
// install.sh 生成的启动器（纯 ASCII 源码）。
// 真实安装路径在同目录 _hermes-purge-home.json —— 这样 .cmd 不用写非 ASCII 路径。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = path.join(__dirname, '_hermes-purge-home.json');
let home;
try {
  home = JSON.parse(fs.readFileSync(cfg, 'utf8')).home;
} catch (e) {
  console.error('[hermes-purge] 读不到安装位置：' + cfg + '（重跑 install.sh / install.ps1）');
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
JS
  # JSON 里用正斜杠：Windows 路径不含双引号，省掉反斜杠转义
  printf '{"home": "%s"}' "$(printf '%s' "$WIN_DEST" | sed 's/\\/\//g')" > "$BIN/_hermes-purge-home.json"
  for cmd in purge hp; do
    printf '@echo off\r\nnode "%%~dp0_hermes-purge-launch.js" %s %%*\r\n' "$cmd" > "$BIN/$cmd.cmd"
  done
  say "已安装命令：$BIN/purge.cmd · $BIN/hp.cmd（PowerShell / cmd 都能直接用）"
else
  for cmd in purge hp; do
    cat > "$BIN/$cmd" <<EOF
#!/usr/bin/env bash
exec node "$DEST/bin/$cmd.js" "\$@"
EOF
    chmod +x "$BIN/$cmd"
  done
  say "已安装命令：$BIN/purge · $BIN/hp"
fi

# 与 install.ps1 对齐：默认把 PATH 写进 shell rc（幂等），--no-path 可跳过
rc_file() {
  case "${SHELL:-}" in
    */zsh)  [ -f "$HOME/.zshrc" ] && { printf '%s' "$HOME/.zshrc"; return; } ;;
    */bash) [ -f "$HOME/.bashrc" ] && { printf '%s' "$HOME/.bashrc"; return; } ;;
  esac
  for f in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$f" ] && { printf '%s' "$f"; return; }
  done
  printf '%s' "$HOME/.profile"
}

case ":$PATH:" in
  *":$BIN:"*) say "PATH 已包含 $BIN" ;;
  *)
    if [ "$NO_PATH" = "1" ]; then
      warn "$BIN 不在 PATH 里（--no-path 已跳过写入）。手动加："
      warn "  export PATH=\"$BIN:\$PATH\""
    elif [ "$IS_WIN" = 1 ]; then
      warn "注意：$(winpath "$BIN") 不在 PATH 里。PowerShell 里加（当前用户，重开终端生效）："
      warn "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$(winpath "$BIN")', 'User')"
    else
      RC="$(rc_file)"
      LINE="export PATH=\"$BIN:\$PATH\""
      if [ -f "$RC" ] && grep -qF "$LINE" "$RC" 2>/dev/null; then
        say "PATH 已在 $(basename "$RC") 里"
      else
        printf '\n# hermes-purge\n%s\n' "$LINE" >> "$RC"
        say "已把 $BIN 写进 $(basename "$RC")（新开终端生效）"
      fi
    fi ;;
esac

if [ "$DO_SETUP" = "1" ]; then
  say ""
  say "—— 装完了，直接跑 purge setup ——"
  args_setup=""
  [ "$DO_YES" = "1" ] && args_setup="--yes"
  # shellcheck disable=SC2086
  exec node "$DEST/bin/purge.js" setup $args_setup
fi

say ""
say "下一步（一条命令，检测 → 计划 → 应用 → 验证）："
say "  purge setup"
