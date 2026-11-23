# 泳道同步板（Windows 比对这张表决定下一步）

> 每轮 macOS 优化后由 mac 泳道更新。Windows 只需 `git fetch && git log origin/lane/mac`，
> 再看下方「Windows 下一步」，就知道要对照什么。

## 当前基线

| 项 | 值 |
|---|---|
| main / lane/mac / lane/win | `1cce452`（mac 侧已推到 3.1.7 的改动，待合并） |
| 版本 | 3.1.6（main）/ 3.1.7 改动在 `lane/mac` |
| macOS 实机（Hermes 0.21.0） | `caps 31 · applied 31 · drifted 0` · L1 9 / L2 14 |
| 0.21.4 沙箱 | `31/31` · L1 14 / L2 14 · revert 逐字节还原 |
| Windows 实机（0.21.x） | 28/31（C13/C14/C16 缺锚点）—— 由 win 泳道补齐 |

## 第 9 轮（2026-11-24 07:10）· 健康检查（backlog 已清空）

| 检查 | 结果 |
|---|---|
| `purge status`（本机 0.21.0） | `caps 31 · applied 31 · pending 0 · drifted 0` |
| `verify --level=1` | ✔ 9 项 · 通过 |
| `verify --level=2` | ✔ 14 项 · 通过 |
| `npm test` | 41+30+33+12+16+10+7+12+4+9+2+4+4+3+5+DOM 全绿 |
| status 耗时 | ≈0.4s（4937 个 .py） |

backlog 8 项全部完成，本轮无代码改动；后续轮次默认做同样的健康检查，
有新任务请往 `docs/mac-backlog.md` 追加一条。

## 本轮变更（第 8 轮 · 排查手册）

`docs/troubleshooting.md` 从 6 节扩到 7 节（445 → 560 行），新增的都是 3.1.x 在真机上踩到并修掉的：

| 节 | 故障 | 判据 |
|---|---|---|
| 7.1 | `apply` 成功但 `status` 报 drifted（sentinel 不匹配） | `apply` 输出 vs `status --json` 里 drifted 的 id |
| 7.2 | `approvals.mode` 改不动 / 注释越叠越多 / 根上没有 `model:` 段 | `grep -A3 '^approvals:' config.yaml` |
| 7.3 | `.env` 里值错却报已生效 | `grep -E '^HERMES_(YOLO\|APPROVAL)_MODE=' .env` |
| 7.4 | macOS `agent install` 后服务不起、日志空白 | `purge agent status` + `launchctl print` + `sample` 栈 |
| 7.5 | `status` 慢 | `time purge status` + `find -name '*.py' \| wc -l` |

每条都写「怎么确认 → 怎么修 → 对应回归测试（`test/sentinel.js` / `test/conf-yaml.js` /
`test/ast-batch.js`）」，速查表补 6 行。

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+4+3+5+DOM 全绿；本机 31/31。

**backlog 到此清空** —— 后续轮次转为健康检查（status 31/31 + npm test），有新的再往 backlog 里加。

### 上一轮（第 7 轮 · 性能）

`purge status` 在本机（4937 个 .py）从 **2.4s → 0.4s**；0.21.4 / 0.21.5 沙箱同样 0.33s，结果都还是 31/31。

两处热点：

1. `platform.findSymbol` 每个符号都要把全树 .py 读一遍（≈160ms × 20 次）
   → 建一次「补丁会碰到的目录」符号索引（`agent/ tools/ hermes_cli/ acp_adapter/`，24MB vs 全树 95MB），
   索引里没有的符号**退回全树扫描**（语义不变，实测索引外符号仍能命中）
2. `probeAst` 每个符号起一个 python 进程 → 新增 `_ast.py locate-batch`，一次解析回答一批，
   按「文件 + mtime + size」缓存

踩到的坑（记下来防复发）：批量缓存最初只记「上次问过的符号」，同一文件问第二个符号时被误判
`symbol-not-found` → C10 从 applied 退化成 drifted（31 → 29）。改成「缺什么补问什么」。
`test/ast-batch.js` 5 项把这个行为锁死（含「同一文件再问另一个符号必须命中」「文件改了不吃旧缓存」）。

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+4+3+5+DOM 全绿；本机 31/31 + L1/L2 通过。

### 上一轮（第 6 轮 · 多版本真实样本）

**0.21.3 拿不到 pristine 样本**（证据）：上游远端没有 `v0.21.3` 标签，只有
`abandoned-rc.*-v0.21.5/6/7`；PyPI 上 `hermes-agent` 最新只到 0.19.0。

改用**可得的真实样本**：`git fetch --depth 1 origin refs/tags/abandoned-rc.10-v0.21.5`
→ `git archive` 取 pristine 树：

| 项 | 结果 |
|---|---|
| anchors | `31 pending · 0 drifted`（主锚全命中，不需要新变体） |
| apply | `31/31 applied` |
| L1 | ✔ 14 项通过 |
| revert | 代码文件与 pristine **逐字节一致** |
| L2 | 未跑 —— 该树 import `tools.approval` 需要 `ruamel.yaml`，沙箱 python 没装（环境限制，与本补丁无关） |

README 兼容矩阵加了 0.21.5 一行（如实标注 L2 未跑的原因）。

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+4+3+DOM 全绿；本机 31/31。

### 上一轮（第 5 轮 · parity 按层汇总）

`purge parity` 的指纹升到 **schema 2**：每条形如 `{id, cap, layer, status, impl}`，另加 `layers` 汇总。

`--diff` 现在先给粗结论再给细节：

```
按层对比
  ✖ code    本机 25/25 · 对端 22/25  缺/异: C13 C14 C16
  ✔ config  本机 4/4 · 对端 4/4
  ✔ prompt  本机 2/2 · 对端 2/2
发现 3 处差异
  C13   对端 drifted  → 本机 applied
```

老指纹（schema=1，没有 `layer`/`layers`）**仍能比对**，不会因为对端没升级就报错。
`test/parity-layers.js` 3 项；`test/parity.js` 同步到 schema 2。

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+4+3+DOM 全绿；本机 31/31。

### 上一轮（第 4 轮 · 面板快照自动刷新）

以前 apply/revert 之后面板还显示旧结论，得手动 `purge desktop sync`。现在：

- `purge apply` / `purge revert` 在**确实改了文件**时自动重建面板快照，并打印
  `面板快照已刷新（apply）`
- 面板没装 → 静默跳过；刷新出错 → 只打一行提示，不影响 apply/revert 本身
- `--no-panel-sync` 可关闭（脚本里想完全控制时用）
- 真机核对过 dist 发现逻辑：`findDists()` 在宿主里同时找到 `apps/desktop/dist` 与
  打包版 `…/app.asar.unpacked/dist`，两个都判为已安装

`test/panel-sync.js` 4 项（没装不写 / apply 刷新 / revert 刷新 / --no-panel-sync 生效）。

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+4+DOM 全绿；本机 31/31。

### 上一轮（第 3 轮 · macOS 开机自启）

新增 `purge agent install|status|uninstall`（**只实现 macOS launchd**；Windows 的计划任务由 win 泳道自己做，
`lib/v2/agent.js` 里刻意没有 win32 分支）：

- `purge agent install` 写 `~/Library/LaunchAgents/com.xiaobingan.hermes-purge.serve.plist`
  （`RunAtLoad` + `KeepAlive`，日志到 `~/Library/Logs/hermes-purge-serve.log`），
  然后 `bootout → enable → bootstrap → kickstart`，最后探测 `/api/health` 报就绪
- 两个坑：① 仓库在 `~/Documents` 下时 launchd 会卡在 TCC 授权（进程挂住、日志空白）
  → 运行时自动复制到 `~/.hermes-purge/app` 再让 plist 指向它；② 只 `bootstrap` 不 `enable`
  的话 label 停在 disabled，服务不会起
- 人工验收：`uninstall → install` 后打印「控制服务已就绪」，`/api/health` 返回 **200**，`agent status` 显示运行中 pid
- `test/agent.js` 4 项（键齐全 / 参数顺序 / 路径 / XML 转义）

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+DOM 全绿；本机 31/31。

### 上一轮（第 2 轮 · `.env` 值感知）

**mac 侧仍只改 `lib/v2/impls.js`（Windows 不必动这里）：**

1. `appendEnv` 之前只判断「键在不在」，`.env` 里写着 `HERMES_APPROVAL_MODE=prompt` 也算已生效
   → 值根本没错改，G02 却报 applied。现在按整行 `K=V` 比对，值不对就**就地改写**那一行。
2. `.env` 不存在时整条 G02 变成 `missing`（不可用）→ 现在会创建文件，且开头不留空白行。

`test/conf-yaml.js` 6 → 9 项（值改写 / 缺文件创建 / 幂等）。

验证：全量 41+30+33+12+16+10+7+12+4+9+2+DOM 全绿；本机 31/31、L1+L2 通过；0.21.4 沙箱 31/31。

### 上一轮（第 1 轮 · 配置层写入审计）

**mac 侧修改了 `lib/v2/impls.js`（两个配置写入 bug）：**

1. `config.yaml` 根上**没有 `model:` 段**时，`yamlMaxTokens` 直接 no-op → C15 永远 `pending`
   （而 apply 却报成功）。现在会补出 `model:` 段 + `max_tokens: 16000`。
2. 「无 approvals 段时整段追加」这条路径写的 `mode: 'off'        # manual | smart | off`
   没有 `[hermes-purge]` 标记、风格与块内重写不一致。现在两条路径统一成
   `mode: 'off'  # [hermes-purge]` / `timeout: 86400  # [hermes-purge]`。

`test/conf-yaml.js` 从 4 项加到 6 项（新增「无 model 段时补出 max_tokens」「追加路径 marker 唯一」）。

验证：全量 41+30+33+12+16+10+7+12+4+6+2+DOM 全绿；本机 31/31；0.21.4 沙箱 `31/31` + L1 通过。

## Windows 下一步

1. `git checkout lane/win && git pull`（main 仍是 `1cce452`；mac 的新改动在 `lane/mac`，
   要提前对齐可以先 `git fetch origin lane/mac && git merge origin/lane/mac`——
   这两个改动都在 `lib/v2/impls.js`，**不在** `lib/anchors/hermes-win.js`，不会和你的锚点冲突）
2. 锚点写进 **`lib/anchors/hermes-win.js`**，注释里**务必带 cap id**（如
   `# [hermes-purge] C13 …`），或者显式给 `sentinel` —— 否则会踩 3.1.6 修掉的
   「改成功却报 drifted」那个坑
3. 跑 `purge apply` → `purge status`（目标 31/31）→ `purge verify --level=2`
4. 导出效果指纹：`purge parity --out=win.json`，发给 mac 侧做 `--diff` 对账
