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

## 本轮变更（第 20 轮 · 0.21.7 兼容性实测 · 上游标签扫完）

`abandoned-rc.1-v0.21.7` 的 pristine 树：

| 项 | 结果 |
|---|---|
| anchors | `31 pending · 0 drifted` |
| apply → status | `31/31 applied` |
| L1 | ✔ 14 项通过 |
| config 改写 | `max_tokens: 16000` / `mode: 'off'` / `timeout: 86400`（每行一个 marker） |
| .env 改写 | `HERMES_APPROVAL_MODE=prompt` → `off` 就地改写，补 `HERMES_YOLO_MODE=1` |
| revert | 与 pristine **逐字节一致** |

**上游现有标签已全部覆盖**：0.21.0（实机）/ 0.21.4 / 0.21.5 / 0.21.6 / 0.21.7（pristine 沙箱），
全部 `31/31`，无需任何新变体 —— 主锚在 0.21.x 全系有效。

## 本轮变更（第 19 轮 · 0.21.6 兼容性实测）

拿上游 `abandoned-rc.1-v0.21.6` 的 pristine 树跑一遍（新一轮上游版本，此前只验到 0.21.5）：

| 项 | 结果 |
|---|---|
| anchors | `31 pending · 0 drifted`（主锚全命中，不需要新变体） |
| apply | `31/31 applied` |
| L1 | ✔ 14 项通过 |
| L2 | 未跑通 —— `import tools.approval` 需要 `ruamel.yaml`，沙箱 python 没装（同一棵树未打补丁时也一样报错，属环境限制） |
| revert | 与 pristine **逐字节一致** |

README 兼容矩阵加 0.21.6 一行。结论：0.21.6 布局与 0.21.4/0.21.5 同源，主锚继续有效。

## 本轮变更（第 17 轮 · Windows 作业单入库）

之前给 Windows 的指引只在聊天里，落不到仓库。这轮写成 **`docs/win-handoff.md`**（208 行），
它照着做就能把 C13/C14/C16 补上：

- 0. 对齐代码（merge `origin/lane/mac`，两者改的文件不重叠）
- 1. 在宿主里找真实落点（`grep 'content": effective_system'` / `prefill_messages`，用 `cat -A` 看清缩进）
- 2. 检查 `_clone_message_for_send` 是否存在（不存在就换 `dict(pfm)` 并说明）
- 3. 往 `lib/anchors/hermes-win.js` 写锚点的完整模板 + 三条铁律（缩进必须真实、注释带 cap id、先 `--dry`）
- 4. 七步验收（status → apply → 31/31 → L1/L2 → 行尾 → revert 逐字节 → 单测）
- 5. 与 mac 对账（`purge parity --out=win.json` ↔ `--diff`）
- 6. 提交 + `scripts/lane-guard.sh --lane=lane/win`
- 报告格式 + 「遇到这三种现象看 troubleshooting 第 7 节」的对照表

README 泳道那段也挂上了链接。本轮纯文档，无代码改动；全量测试仍全绿，本机 31/31。

## 本轮变更（第 14 轮 · 服务被 kill 后不会自己起来）

**真机发现**：`kill -9` 掉控制服务后，plist 里 `KeepAlive` 是 true、`print-disabled` 是 enabled，
但进程**不会自动重启**（`last exit = -9`，`pid = -`）。拿一个 `sleep 300` 的最小 LaunchAgent 做对照，
它连 `RunAtLoad` 都不生效 —— **是这台机器的策略，不是我们的 plist**（锁屏 / 无图形会话 / 受限机器常见）。

应对：

- 新增 **`purge agent restart`**（`launchctl kickstart -k`），实测能把服务立刻拉起，`/api/health` 回 200
- `purge agent status` 在「已加载但没在跑」时不再只报 `pid=-`，而是直接说原因并给命令
- plist 的 `KeepAlive` 改成 dict（`SuccessfulExit: false`）+ `ThrottleInterval: 10`：
  崩溃/被信号杀会重启，SIGTERM 正常退出不重启
- `docs/troubleshooting.md` 7.4 补了这条实机结论与「最小对照实验」的判据
- `test/agent-restart.js` 3 项

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+4+3+5+4+3+DOM 全绿；本机 31/31。

## 本轮变更（第 13 轮 · 面板快照过期检测）

上一轮在真机上发现：面板里嵌的快照停在 **3.1.0 / 17:53**，而代码已经是 3.1.6。
原因是自动刷新只在 `apply`/`revert` 真改文件时触发，改代码/改文档不走那条路。

- `lib/v2/desktop.js`：新增 `snapshotInfo()` / `isStale()`（从面板脚本里读它内嵌的 version + generatedAt）
- `purge doctor`：新增「面板快照」检查 —— 过期会标黄并直接给修复命令
  `面板快照  过期：面板里是 3.1.0（…），当前 3.1.6 → purge desktop sync`
- `purge desktop status`：打印快照版本/时间，并标「已过期 / 与当前版本一致」
- `test/panel-stale.js` 4 项（读版本 / 报过期 / sync 后一致 / desktop status 显示）

验证：全量 41+30+33+12+16+10+7+12+4+9+2+4+4+3+5+4+DOM 全绿；本机 31/31 + L2 通过。

## 本轮变更（第 73 轮 · 跟上 71 → 77 条 cap；C50/C51 归类）

main 前进：`f98180c feat: 第五轮挖静默截断，71 → 77 条 cap (#14)`。合并后 `pending 2 drifted 2`：

| cap | 情况 | 处理 |
|---|---|---|
| C48 / C49 | 文件都在，待应用 | `apply` 后生效 |
| C51 `fs.nt_namespace_off` | `get_nt_namespace_error()` 0.21.4+ 才有 | 标 `since: 0.21.4` |
| C50 `redact.walk_depth` | 锚点 `REDACT_WALK_MAX_DEPTH = 320` **在 0.21.0~HEAD 全部样本里都不存在** | 先标 `since` 归入版本缺口，但**锚点本身需要 win 侧修正** |

这已是第三次发现 win 侧锚点凭空写（前两次：C31/C31b/C32b 的 `_scan_text` /
`_padded_code_findings` / `is_blocked_device_path`）。建议它们以后加锚点前先
`grep -rn "def <符号>" /path/to/hermes-agent` 确认符号真实存在。

结果：

```
本机 0.21.0   caps 77 · applied 65 · drifted 0   L1 19 / L2 14 通过
0.21.4 沙箱   caps 77 · applied 72 · drifted 0
0.21.5 沙箱   caps 77 · applied 72 · drifted 0
全量          21 组全绿
```

## 本轮变更（第 67 轮 · 修 insertAfter 误判 + 沙箱那 3 条异常）

上一轮结尾留了「0.21.4/0.21.5 沙箱 pending 1 · drifted 2」，这轮查清了，是两个独立问题：

**① `insertAfter` 判活太松（真 bug，会影响所有 `ins()` 型 cap）**

老判定：锚点后 240 字符内出现同样的 `return X` 就算 applied。
函数体本来就常以同样的 return 开头 → **没打补丁也报 applied**。0.21.5 上的 C37 就是这样被漏掉的
（status 说已生效，文件里却没有 marker）。

新判定：必须看到「锚点 + 我们插进去那句 + `  # [hermes-purge]`」。
`test/insert-after.js` 4 项锁住（含「函数体同形 return 不算」「apply 后确实有 marker」）。

**② C42/C43 的锚点在上游根本不存在**

`trailing_amp_background_command` / `locked_skill_block` 在 0.21.0~HEAD 都不存在
（`terminal_tool_guards.py` 里真实的守卫是 `gateway_lifecycle_block` / `self_repo_block`）。
标注 `since` 归入「该版本无此机制」，不污染 drifted。顺带让 `0.0.0` 占位版本的树也能正确归类。

结果：

```
本机 0.21.0   caps 64 · applied 56 · drifted 0   L1 18 / L2 14 通过
0.21.4 沙箱   caps 64 · applied 61 · drifted 0   L1 28 项通过
0.21.5 沙箱   caps 64 · applied 61 · drifted 0   L1 28 项通过
全量          21 组全绿
```

## 本轮变更（第 66 轮 · 合并 64 条 cap + 两套批处理实现去重）

main 连推 3 个提交（50 → 64 条 cap，status 29.5s→3.3s 收尾，3.5.1 发布）。合并时发现
**两边各自实现了一套「批量 AST 定位」**，必须收敛成一套，否则缓存/契约互相打架：

| 项 | mac 侧 | win 侧 | 合并结果 |
|---|---|---|---|
| 子命令 | `locate-batch`（带 body_line） | `locate-many` | 统一 `locate-batch`，删掉重复实现 |
| 返回契约 | `{name: {ok,line,…}}` | `{ok, symbols:{name: {...}\|null}}` | **用 win 的契约**（它的 `warmLocate/locOf` 依赖它） |
| 缓存 | 我的 per-file mtime 缓存 | `LOC_CACHE` + `warmLocate` 预热 | **用 win 的**（`probeAst` 改调 `locOf`） |
| 索引 | 我的部分目录索引 | 全量 `symbolIndex` | **用 win 的**（语义与老的逐次扫描一致） |

顺带修 `locate-batch` 的契约 bug：找不到符号时原来返回 `{ok:false…}`，他们的调用方当 `null` 用，
导致整批 AttributeError —— 改成返回 `null`。

另外补 C40 `redact.off` 在 0.21.0 的落点（主锚 `_redact_enabled()` 是 0.21.4+ 才有；
0.21.0 用模块级 `_REDACT_ENABLED = os.getenv(...)`，直接改常量）。

结果：

```
本机 0.21.0   caps 64 · applied 56 · pending 0 · drifted 0   L1 18 / L2 14 通过   status 1.75s
0.21.4 沙箱   caps 64 · applied 57 · drifted 0
0.21.5 沙箱   caps 64 · applied 57 · drifted 0
全量          20 组全绿
```

## 本轮变更（第 65 轮 · 跟上 50 条 cap；发现 win 写错了 3 个锚点）

main 又前进：`921d1f2 feat: 第二轮补齐宿主拦截点，41 → 50 条 cap (#7)`。合并后本机 `pending 6 drifted 3`。

**逐条查下来，C31 / C31b / C32b 的锚点在任何 0.21.x 里都不存在**：

```
grep -rl "def _scan_text"            0.21.0 / 0.21.4 / 0.21.5 / 0.21.6 / 0.21.7 → 全部 0 命中
grep -rl "def _padded_code_findings" → 全部 0 命中
grep -rl "def is_blocked_device_path" → 全部 0 命中
```

即主锚写的是上游根本不存在的函数名（真正的扫描入口是 `scan_file` / `scan_skill`，
读侧拒绝读是 `get_read_block_error`）。这三条在**任何**宿主上都不可能生效。

mac 侧按真实落点补变体（`lib/anchors/hermes-0.21.0-addendum.js`）：

| cap | 真实落点 | 写法 |
|---|---|---|
| C31 | `tools/skills_guard.py: scan_file()` | `return []` |
| C31b | `tools/skills_guard.py: scan_skill()` | 返回空 `ScanResult(skill_path.name, source, "community", "safe", [], "")` |
| C32b | `agent/file_safety.py: get_read_block_error()` | `return None` |

运行时验证过（不是只看代码）：`scan_file → []`、`scan_skill → ScanResult`、`py_compile` 通过。

另外把「版本缺口」判定改成**兜底**（原来放在循环前，会把 0.0.0 占位版本的 rc 树误判）：

```
先跑所有实现；都没命中时：
  有 :missing            → unsupported（文件不存在）
  否则 hostVersion < since → unsupported（版本太老）
  否则                    → drifted（真漂移）
```

结果：

```
本机 0.21.0   caps 50 · applied 48 · drifted 0   L1 16 / L2 14 通过
0.21.4 沙箱   caps 50 · applied 49 · drifted 0
0.21.5 沙箱   caps 50 · applied 49 · drifted 0
全量          20 组全绿（dsh 33 项、v2 37 项均未受影响）
```

## 本轮变更（第 64 轮 · 跟上 41 条 cap，并区分「版本缺口」与「漂移」）

新判据生效第一轮就抓到 main 前进：`60bc97c feat: 补上宿主防护层，31 → 41 条 cap`。
合并后本机出现 **pending 7 · drifted 3**，逐条查过：

| cap | 0.21.0 上的情况 | 处理 |
|---|---|---|
| G03 / C21 / C22 / C22b / C23 / C23b / C24 | 文件都在，只是待应用 | `apply` 后全部生效 |
| C25 `fs.credential_write_allow` | 0.21.0 没有 `deny_path_under()`，等价物是 `build_write_denied_paths(home)` | 新增 `lib/anchors/hermes-0.21.0-addendum.js`，在该函数里 `return set()` |
| C26 `delegate.depth_raised` | `tools/delegate_tool_config.py` **不存在** | 标 `unsupported` |
| C27 `prune.proactive_off` | `agent/context_compressor_prune.py` **不存在** | 标 `unsupported` |

顺带修了两个真问题：

1. **`insertAfter` 双 marker**：`ret` 里自己写了 `# [hermes-purge]`，applier 又补一个 →
   `return set()  # …  # [hermes-purge]`。改成 `ret` 不带 MARK、变体显式给 `sentinel`。
2. **「该版本没有此机制」不该算 drifted**：所有尝试要么 `:missing` 要么 `:drifted` 且至少一处缺文件
   → 报 `unsupported`（带说明「本机宿主没有该机制所在文件（版本较老），非漂移」）。
   **只对 hermes adapter 生效** —— dsh 夹具那边「文件不存在」就该是 drifted（改完全量 dsh 33 项仍绿）。

结果：**caps 41 · applied 39 · pending 0 · drifted 0 · unsupported 2**，L1 13 项 / L2 14 项通过。
0.21.4 / 0.21.5 沙箱：`41 · applied 40 · drifted 0`（各剩 1 条版本缺口）。

`test/version-gap.js` 3 项（缺文件报 unsupported / 不计入 drifted / dsh 不受影响）；全量 20 组全绿。

## 本轮变更（第 62 轮 · mac 安装器对齐 win 的三项能力）

Windows 那边刚给 `install.ps1` 补了三件事，mac 侧此前**只在 Windows 成立**，这轮补齐：

| 能力 | ps1（已有） | sh（本轮补上） |
|---|---|---|
| 镜像 | `-BaseUrl` | `--base-url=URL` / `HERMES_PURGE_BASE_URL` |
| PATH | 默认写用户 PATH，`-NoPath` 跳过 | **默认写 shell rc**（`.zshrc`/`.bashrc`/`.profile`，幂等），`--no-path` 跳过 |
| 下载失败 | 提示换镜像 | `curl --retry 3 --connect-timeout 20` + 提示换镜像 |

真机验证（空 HOME、自定义 bin）：

```
已安装到 /tmp/sh1/app（版本 latest，无需登录）
已把 /tmp/sh1/bin 写进 .zshrc（新开终端生效）
$ /tmp/sh1/bin/purge --version → 3.2.0
重复装一次 → PATH 已在 .zshrc 里（rc 里仍只有 1 行）
--no-path   → rc 不动，只提示手动加
```

`test/install-sh.js` 5 项（三条静态对齐 + 真跑幂等 + `--no-path` 不碰 rc）；全量 19 组全绿。

## 本轮变更（第 56 轮 · 同步 win 侧 3.1.7~3.2.0）

**之前巡检判据错了**：我一直看 `origin/main..origin/lane/win`（那条分支停在 1cce452），
而 win 侧实际走的是 `lane/win-merge` → `main`。结果 main 上有 8 个提交我完全没看到。

已把 `origin/main` 合进 `lane/mac`（`92d8dd0`）。冲突两处，都按「两边都保留」解决：

- `lib/v2/ast.js` 导出：mac 的 `locateMany/clearCache` + win 的 `runHelper` 并集
- `package.json` scripts：mac 6 条 + win 2 条（`test:win` / `test:engine`）全部保留

合并进来的 win 侧内容：`install.ps1` 自举 TLS1.2/curl 兜底/`-BaseUrl` 镜像、默认写用户 PATH
（`-NoPath` 跳过）、桌面端首次启动免责声明、**修 `desktop sync` 丢 token**、approvals 断言不依赖键顺序。

合并后验证：全量 18 组全绿、本机 31/31、`verify --level=2` 通过。

**巡检判据已改**：现在看 `git rev-list --count origin/lane/mac..origin/main`
（>0 = 对方又前进了，要合并），而不是只看 `lane/win`。当前：落后 0 / 领先 18。

## 最近巡检（滚动更新，不逐轮追加）

> 约定：巡检全绿且没有任何变化时**不再提交**（避免每 10 分钟一条文档 commit）；
> 下面这张表只保留最近一次结果，出现红项或状态变化才更新并提交。

| 项 | 最近一次结果（2026-11-24 07:20） |
|---|---|
| `purge status`（本机 0.21.0） | `caps 31 · applied 31 · pending 0 · drifted 0` |
| `purge doctor` | 健康 |
| `verify --level=1` / `--level=2` | ✔ 9 项 / ✔ 14 项 · 通过 |
| `npm test` | 41+30+33+12+16+10+7+12+4+9+2+4+4+3+5+DOM 全绿 |
| status 耗时 | ≈0.4s（4937 个 `.py`） |
| 文档内部链接 | 12 个 md，断链 0 |

backlog 8 项已全部完成。有新任务往 `docs/mac-backlog.md` 追加一条即可。

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
