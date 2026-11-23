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
- [ ] **0.21.3 真实样本验证**：找一棵 pristine 0.21.3 树跑 31/31（现在只有 0.21.0 / 0.21.4 实测）
- [ ] **大仓性能**：`purge status` 在 6000+ 行文件上的耗时（现在没量过）
- [ ] **文档**：`docs/troubleshooting.md` 补 3.1.x 遇到的新故障（sentinel / config 叠注释）
