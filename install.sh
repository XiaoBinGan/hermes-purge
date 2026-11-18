#!/usr/bin/env bash
# hermes-purge 一键安装（macOS / Linux）
#
#   ./install.sh                 # 装到 ~/.hermes-purge，并建 purge / hp 两个命令
#   ./install.sh --uninstall     # 删掉命令与目录
#   HERMES_PURGE_HOME=... ./install.sh
#   HERMES_PURGE_BIN=...  ./install.sh      # 命令装到别处（默认 ~/.local/bin）
#
# 只做三件事：确认 Node ≥18、把仓库放到固定位置、在 PATH 里留两个 shim。
# 不改宿主、不写系统目录、不需要 sudo。
set -euo pipefail

REPO="${HERMES_PURGE_REPO:-https://github.com/XiaoBinGan/hermes-purge.git}"
DEST="${HERMES_PURGE_HOME:-$HOME/.hermes-purge}"
BIN="${HERMES_PURGE_BIN:-$HOME/.local/bin}"
MODE=install

for a in "$@"; do
  case "$a" in
    --uninstall|-u) MODE=uninstall ;;
    --home=*) DEST="${a#*=}" ;;
    --bin=*)  BIN="${a#*=}" ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
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
  command -v git >/dev/null 2>&1 || die "没有 git，且不是从仓库里跑的：请先 git clone。"
  [ -d "$DEST/.git" ] || git clone --depth 1 "$REPO" "$DEST"
  say "已克隆到 $DEST"
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

say ""
say "下一步（一条命令，检测 → 计划 → 应用 → 验证）："
say "  purge setup"
