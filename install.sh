#!/usr/bin/env bash
# hermes-purge 一键安装（macOS / Linux）
#
#   ./install.sh                 # 装到 ~/.hermes-purge，并建 purge / hp 两个命令
#   ./install.sh --setup         # 装完直接跑 purge setup（一条命令装好）
#   ./install.sh --setup --yes   # 同上，但不问确认（脚本/CI 用）
#   ./install.sh --uninstall     # 删掉命令与目录
#   HERMES_PURGE_HOME=... ./install.sh
#   HERMES_PURGE_BIN=...  ./install.sh      # 命令装到别处（默认 ~/.local/bin）
#
# 只做三件事：确认 Node ≥18、把仓库放到固定位置、在 PATH 里留两个 shim。
# 不改宿主、不写系统目录、不需要 sudo。
set -euo pipefail

REPO="${HERMES_PURGE_REPO:-https://github.com/XiaoBinGan/hermes-purge.git}"
GH="${HERMES_PURGE_GH:-https://github.com/XiaoBinGan/hermes-purge}"
VERSION="${HERMES_PURGE_VERSION:-latest}"
DEST="${HERMES_PURGE_HOME:-$HOME/.hermes-purge}"
BIN="${HERMES_PURGE_BIN:-$HOME/.local/bin}"
MODE=install
DO_SETUP="${HERMES_PURGE_SETUP:-0}"
DO_YES=0

for a in "$@"; do
  case "$a" in
    --uninstall|-u) MODE=uninstall ;;
    --setup) DO_SETUP=1 ;;
    --yes|-y) DO_SETUP=1; DO_YES=1 ;;
    --home=*) DEST="${a#*=}" ;;
    --version=*) VERSION="${a#*=}" ;;
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

if [ "$MODE" = uninstall ]; then
  rm -f "$BIN/purge" "$BIN/hp"
  say "已移除命令：$BIN/purge · $BIN/hp"
  if [ -d "$DEST" ] && [ ! -L "$DEST" ]; then
    rm -rf "$DEST"
    say "已删除 $DEST"
  elif [ -L "$DEST" ]; then
    rm -f "$DEST"
    say "已移除链接 $DEST"
  fi
  say "宿主上的补丁不会因此消失；要撤销补丁用：purge revert（或先装回来再 revert）"
  exit 0
fi

command -v node >/dev/null 2>&1 || die "找不到 node。先装 Node.js ≥18：https://nodejs.org/"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 版本太低（$((node -v))）。需要 ≥18。"

SRC="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SRC/bin/purge.js" ]; then
  # 从仓库里直接跑：用软链指向当前 checkout，改代码即时生效
  mkdir -p "$(dirname "$DEST")"
  if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
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
    curl -fsSL "$SRC_URL" -o "$TMPD/src.tar.gz" || die "下载失败：$SRC_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMPD/src.tar.gz" "$SRC_URL" || die "下载失败：$SRC_URL"
  else
    die "既没有 curl 也没有 wget。请手动下载 $SRC_URL 解开后，在目录里跑 ./install.sh"
  fi
  tar xzf "$TMPD/src.tar.gz" -C "$TMPD" || die "解压失败（包损坏？）"
  SRC_DIR="$(find "$TMPD" -maxdepth 1 -type d -name 'hermes-purge-*' | head -1)"
  [ -n "$SRC_DIR" ] || die "包结构不对：里面没有 hermes-purge-* 目录"
  [ -f "$SRC_DIR/bin/purge.js" ] || die "包结构不对：没有 bin/purge.js"
  mkdir -p "$DEST"
  # 复制内容（保留 .git 之类不存在的也无所谓）
  cp -R "$SRC_DIR"/. "$DEST"/
  say "已安装到 $DEST（版本 ${VERSION}，无需登录）"
fi

mkdir -p "$BIN"
for cmd in purge hp; do
  cat > "$BIN/$cmd" <<EOF
#!/usr/bin/env bash
exec node "$DEST/bin/$cmd.js" "\$@"
EOF
  chmod +x "$BIN/$cmd"
done
say "已安装命令：$BIN/purge · $BIN/hp"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "注意：$BIN 不在 PATH 里。把下面一行加到 ~/.zshrc 或 ~/.bashrc："
     warn "  export PATH=\"$BIN:\$PATH\"" ;;
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
