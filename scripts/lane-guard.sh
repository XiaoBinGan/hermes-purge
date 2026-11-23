#!/usr/bin/env bash
# 泳道护栏：检查「两条线不会互相踩」的几条硬约束，红项直接非 0 退出。
# 用法：scripts/lane-guard.sh [--lane=lane/mac]
set -euo pipefail
cd "$(dirname "$0")/.."

LANE="lane/mac"
for a in "$@"; do
  case "$a" in
    --lane=*) LANE="${a#*=}" ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

fail=0
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✔ %s\n' "$*"; }
bad()  { printf '  ✖ %s\n' "$*"; fail=1; }

say "泳道护栏（$LANE）"

# 1) 本泳道不能碰对方的锚点文件
other="lib/anchors/hermes-win.js"
[ "$LANE" = "lane/win" ] && other="lib/anchors/hermes-0.21.0.js"
touched="$(git log --oneline "origin/main..$LANE" -- "$other" | head -5 || true)"
if [ -z "$touched" ]; then ok "没碰过对方的锚点文件（$other）"
else bad "本泳道改过 $other："; printf '%s\n' "$touched"; fi

# 2) main 必须有分支保护（直推会被服务端拒绝）
if command -v gh >/dev/null 2>&1; then
  prot="$(gh api repos/XiaoBinGan/hermes-purge/branches/main/protection --jq '(.required_pull_request_reviews!=null) and .enforce_admins.enabled' 2>/dev/null || echo unknown)"
  case "$prot" in
    true) ok "main 分支保护在（必须 PR + 管理员同样受限）" ;;
    unknown) say "  · 跳过 main 保护检查（gh 未认证或离线）" ;;
    *) bad "main 分支保护异常：$prot" ;;
  esac
fi

# 3) 本地 main 不能落后/领先 origin/main（防止有人在本地直推进 main 再手滑推上去）
if git rev-parse --verify -q main >/dev/null && git rev-parse --verify -q origin/main >/dev/null; then
  if [ "$(git rev-parse main)" = "$(git rev-parse origin/main)" ]; then ok "本地 main 与 origin/main 一致"
  else bad "本地 main 与 origin/main 不一致（先 git fetch，再确认没直推）"; fi
fi

# 4) 泳道分支必须能无冲突地合进 main（用 merge-tree 干跑，不落地）
if git rev-parse --verify -q origin/main >/dev/null; then
  base="$(git merge-base "origin/main" "$LANE")"
  if out="$(git merge-tree --write-tree "origin/main" "$LANE" 2>&1)"; then
    if printf '%s' "$out" | grep -q 'CONFLICT'; then bad "合进 main 会冲突（merge-tree 报告 CONFLICT）"
    else ok "合进 main 无冲突（merge-tree 干跑）"; fi
  else
    say "  · merge-tree 不可用（git 版本偏老），跳过冲突预检"
  fi
fi

[ "$fail" = 0 ] && say "结论：护栏全部通过" || say "结论：有红项，先修再继续"
exit "$fail"
