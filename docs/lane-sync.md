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

## 本轮变更（第 3 轮 · macOS 开机自启）

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
