#!/usr/bin/env bash
# 打一次发布：npm 包 + 源码包（tar.gz/zip）+ 安装脚本，全部作为公开 Release 资产。
# 用法：scripts/release.sh [--notes-file=path]
set -euo pipefail
cd "$(dirname "$0")/.."

VER="$(node -p "require('./package.json').version")"
NOTES=""
for a in "$@"; do
  case "$a" in
    --notes-file=*) NOTES="${a#*=}" ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

TAG="v$VER"
OUT="dist-release"
rm -rf "$OUT"; mkdir -p "$OUT"

echo "== 1/4 npm 包 =="
npm pack --silent >/dev/null
mv "hermes-purge-$VER.tgz" "$OUT/hermes-purge-$VER.tgz"
cp "$OUT/hermes-purge-$VER.tgz" "$OUT/hermes-purge.tgz"

echo "== 2/4 源码包 =="
git archive --format=tar.gz --prefix="hermes-purge-$VER/" -o "$OUT/hermes-purge-src.tar.gz" HEAD
git archive --format=zip    --prefix="hermes-purge-$VER/" -o "$OUT/hermes-purge-src.zip" HEAD

echo "== 3/4 安装脚本 =="
cp install.sh "$OUT/install.sh"
cp install.ps1 "$OUT/install.ps1"

echo "== 4/4 上传 Release $TAG =="
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$OUT"/* --clobber
else
  if [ -n "$NOTES" ]; then
    gh release create "$TAG" "$OUT"/* --title "hermes-purge $VER" --notes-file "$NOTES"
  else
    gh release create "$TAG" "$OUT"/* --title "hermes-purge $VER" --notes "hermes-purge $VER"
  fi
fi

echo
echo "完成。匿名可用（不需要登录）："
echo "  安装脚本  https://github.com/XiaoBinGan/hermes-purge/releases/latest/download/install.sh"
echo "  npm 包    https://github.com/XiaoBinGan/hermes-purge/releases/latest/download/hermes-purge.tgz"
echo "  源码包    https://github.com/XiaoBinGan/hermes-purge/releases/latest/download/hermes-purge-src.tar.gz"
