# macOS 泳道待办（每轮取第一条未完成项）

规则：一轮只做一件事，做完必须 `npm test` 全绿 + 本机 `purge status`（31/31）不变，
然后提交到 `lane/mac` 并 push。**不碰** `lib/anchors/hermes-win.js`、**不直推** `main`、
**不随手改版本号**（版本由集成方在合并时改）。

- [x] **配置层写入幂等审计**（3.1.7）：`yamlMaxTokens` 在根上无 `model:` 段时直接 no-op
      → C15 永远 pending；追加路径的 approvals 风格不统一 → 一并修掉，测试 +2
- [x] **`.env` 幂等 + 去重**（第 2 轮）：`appendEnv` 只看键不看值（`HERMES_APPROVAL_MODE=prompt`
      也算已生效）、`.env` 不存在时整条 cap 不可用 → 改成值感知 + 就地改写 + 缺文件自动创建
- [x] **`purge serve` launchd 守护**（第 3 轮）：新增 `purge agent install|status|uninstall`。
      踩到两个坑：① 仓库在 ~/Documents 下，launchd 访问会卡在 TCC 授权（进程挂住、日志空白）
      → 运行时自动复制到 `~/.hermes-purge/app`；② `bootstrap` 后 label 可能停留 disabled
      → 补 `enable` + `kickstart -kp`，并做健康探测
- [x] **面板自动刷新**（第 4 轮）：apply/revert 真的改了东西时自动重建面板快照（`--no-panel-sync` 可关，
      面板没装时静默跳过，刷新失败不影响主流程）
- [x] **`purge parity` 按层汇总**（第 5 轮）：指纹加 `layers`（code/config/prompt 各自 applied/total），
      `--diff` 先输出「哪层缺、缺哪几条」再逐条列；老的 schema=1 指纹仍能比
- [x] **0.21.3 样本**（第 6 轮）：上游没有 `v0.21.3` 标签（只有 `abandoned-rc.*-v0.21.5/6/7`），
      PyPI 上 `hermes-agent` 最高也只到 0.19.0 —— **0.21.3 拿不到 pristine 样本**。
      改用可得的 `abandoned-rc.10-v0.21.5` 做真实样本：`31/31 applied`、L1 14 项通过、
      `revert` 代码逐字节还原；L2 因沙箱缺 `ruamel.yaml` 未跑（环境限制）
- [x] **大仓性能**（第 7 轮）：`purge status` 2.4s → **0.4s**。
      两处热点：① `findSymbol` 每个符号都把全树 .py 读一遍（≈160ms/次 × 20 次）
      → 建一次「补丁会碰到的目录」符号索引（24MB vs 全树 95MB），未命中再退回全树；
      ② `probeAst` 每个符号起一个 python 进程 → `_ast.py locate-batch` 一次解析回答一批，
      按「文件+mtime+size」缓存。踩到的坑：缓存只记「上次问过的符号」，同文件第二个符号
      被误判 symbol-not-found，C10 从 applied 退化成 drifted → 改成缺什么补问什么
- [x] **文档**（第 8 轮）：`docs/troubleshooting.md` 增补第 7 节 —— 3.1.x 在真机上踩到并修掉的
      五类故障（sentinel 不匹配 / config 叠注释·mode 不改 / .env 值不改 / launchd TCC /
      status 慢），每条给「判据命令 + 修法 + 对应回归测试」；速查表补 6 行

## 追加（第 13 轮，自查发现的缺陷）

- [x] **面板快照过期检测**：改代码/改文档不走 apply，快照会一直是旧版本（用户看到过期结论）。
      `doctor` 与 `desktop status` 现在会报「过期（面板里是 X，当前 Y）→ purge desktop sync」；
      `test/panel-stale.js` 4 项锁住
