# 泳道同步板（Windows 比对这张表决定下一步）

> 每轮 macOS 优化后由 mac 泳道更新。Windows 只需 `git fetch && git log origin/lane/mac`，
> 再看下方「Windows 下一步」，就知道要对照什么。

## 当前基线

| 项 | 值 |
|---|---|
| main / lane/mac / lane/win | `1cce452` |
| 版本 | 3.1.6 |
| macOS 实机（Hermes 0.21.0） | `caps 31 · applied 31 · drifted 0` · L1 9 / L2 14 |
| 0.21.4 沙箱 | `31/31` · L1 14 / L2 14 · revert 逐字节还原 |
| Windows 实机（0.21.x） | 28/31（C13/C14/C16 缺锚点）—— 由 win 泳道补齐 |

## 本轮变更

（首轮：建立本同步板与 mac-backlog，未改代码）

## Windows 下一步

1. `git checkout lane/win && git pull`（已同步到 `1cce452`）
2. 锚点写进 **`lib/anchors/hermes-win.js`**，注释里**务必带 cap id**（如
   `# [hermes-purge] C13 …`），或者显式给 `sentinel` —— 否则会踩 3.1.6 修掉的
   「改成功却报 drifted」那个坑
3. 跑 `purge apply` → `purge status`（目标 31/31）→ `purge verify --level=2`
4. 导出效果指纹：`purge parity --out=win.json`，发给 mac 侧做 `--diff` 对账
