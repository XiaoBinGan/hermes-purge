# 泳道同步板（Windows 照这个决定下一步）

> 用法：`git fetch origin && git log --oneline origin/lane/mac` 看 mac 又做了什么，
> 然后从上往下读本文件 —— **基线 → 待办 → 怎么验收**。逐轮明细在
> [`lane-history.md`](lane-history.md)，这里只留「当前该干什么」。

## 当前基线

| 项 | 值 |
|---|---|
| 分支 | `main` = `ef05392`；`lane/mac` 已合并 main 全部内容（落后 0），另有 30 个提交 |
| 版本 | 3.8.2（两边一致） |
| 补丁面 | **78 条**（两边 cap 清单完全一致） |
| macOS 实机（Hermes 0.21.0） | `caps 78 · applied 65 · pending 0 · drifted 0` · L1 19 / L2 14 通过 |
| 0.21.4 / 0.21.5 / 0.21.6 / 0.21.7 沙箱 | `applied 76 · unsupported 3 · drifted 0` |
| 效果指纹 | `purge parity --out=mac.json` → 65/78 |

## ⚠️ Windows 侧待办（2026-11-24 22:50 更新，三件事）

### ① 三条 cap 的锚点在任何版本都不存在 —— 在 main 上永远不生效

`lib/patches.js` 里这三条的主锚写的是上游根本不存在的函数：

| cap | 主锚（不存在） | 真实入口 |
|---|---|---|
| C31 | `_scan_text` | `tools/skills_guard.py: scan_file()` |
| C31b | `_padded_code_findings` | `tools/skills_guard.py: scan_skill()` |
| C32b | `is_blocked_device_path` | `agent/file_safety.py: get_read_block_error()` |

mac 侧在 `lib/anchors/hermes-0.21.0-addendum.js` 里补了变体，实测**真正生效**（运行时验过：
`scan_file → []`、`scan_skill → ScanResult`）。main 上这三条会一直是 `drifted`。

### ② 六条 cap 需要 `since` 标注，否则老宿主永远报 drifted

`C26 / C27 / C51` → `since: '0.21.4'`；`C42 / C43 / C50` → `since: '0.21.99'`（锚点待修）。
没有标注时，0.21.0 这类宿主上它们恒为 `drifted`，「drifted 0」这个判据就废了。

### ③ `insertAfter` 判活太松 —— 可能整片假 applied

`lib/v2/impls.js` 的老判定是「锚点后 240 字符内出现同样的 `return X` 就算 applied」。
函数体本来就常以同样的 return 开头 → **没打补丁也报 applied**。mac 侧已改成必须见到
「插入句 + `  # [hermes-purge]`」。**建议 Windows 先自查**：

```bash
purge status --json | python3 -c "
import json,sys
print(sum(1 for r in json.load(sys.stdin)['rows'] if r['status']=='applied'), 'applied')"
grep -c 'hermes-purge' G:/hermes/hermes-agent/tools/terminal_tool_guards.py
# 状态说 applied 但文件里 marker 数是 0 → 就是这个 bug
```

### ④ 剩下 3 条锚点在上游任何版本都不存在（0.21.x 全系无法生效）

| cap | 声称的锚点 | 上游实况 |
|---|---|---|
| C27 | `agent/context_compressor_prune.py: would_proactively_prune()` | **文件不存在**（0.21.0~0.21.7 与 HEAD 全无） |
| C50 | `REDACT_WALK_MAX_DEPTH = 320` | 常量在**任何版本**都不存在 |
| C52 | `tools/approval_wmic.py` | **文件不存在**（0.21.0~HEAD 全无） |

mac 侧已把能落的都落到真实函数上（C31→`scan_file`、C31b→`scan_skill`、C32b→`get_read_block_error`、
C40→`_REDACT_ENABLED`、C42/C43→`gateway_lifecycle_block`/`self_repo_block`），
0.21.4~0.21.7 统一到 **76/79**。剩下这 3 条需要 win 侧给出真实锚点。

### ⑤ 3.8.2 新增的 C52 锚点在任何样本里都不存在

`tools/approval_wmic.py` 在 0.21.0 / 0.21.4 / 0.21.5 / 0.21.6 / 0.21.7 / 上游 HEAD **全部 0 命中**。
已标 `since: 0.21.99` 归入版本缺口，但锚点本身需要 win 侧核实（第四次了）。

C53（`agent/fallback_cooldown.py`）/ C54（`agent/turn_stop_gates.py`）没问题：
0.21.4+ 都有该文件，实测 `applied`。

**拿到修复**：`git merge origin/lane/mac`（不会碰 `lib/anchors/hermes-win.js`），
或直接 `git checkout origin/lane/mac -- lib/v2/impls.js lib/patches.js` 只取这两处。

## 怎么验收（Windows 侧照这个判）

```bash
# 1) 状态：三条锚点修好后，C31/C31b/C32b 不应再是 drifted
purge status --json | python3 -c "
import json,sys
rows = json.load(sys.stdin)['rows']
bad = [r for r in rows if r['status'] not in ('applied','unsupported')]
print('非 applied/unsupported:', len(bad))
[print(' ', r['id'], r['status']) for r in bad]"

# 2) 效果指纹：和 mac 对账，一致才是真同步
purge parity --out=win.json
#   把 win.json 发回来，或自己跟 mac 的比：
purge parity --diff=mac.json
#   一致 → 退出码 0：「两边效果一致：N 条 cap 的 status 与实现层完全相同」

## 历史（按轮次倒序）

逐轮的改动明细搬到了 [`lane-history.md`](lane-history.md)，本文件只留「当前该干什么」，
免得每轮往下堆。
