# macOS 泳道待办（每轮取第一条未完成项）

规则：一轮只做一件事，做完必须 `npm test` 全绿 + 本机 `purge status`（31/31）不变，
然后提交到 `lane/mac` 并 push。**不碰** `lib/anchors/hermes-win.js`、**不直推** `main`、
**不随手改版本号**（版本由集成方在合并时改）。

- [x] **配置层写入幂等审计**（3.1.7）：`yamlMaxTokens` 在根上无 `model:` 段时直接 no-op
      → C15 永远 pending；追加路径的 approvals 风格不统一 → 一并修掉，测试 +2
- [ ] **`.env` 幂等 + 去重**：`appendEnv` 现在的行为在重复 apply 下是否稳定
- [ ] **`purge serve` launchd 守护**：macOS 开机自启，面板按钮不依赖手动起服务
- [ ] **面板自动刷新**：宿主状态变化后（apply/revert）自动重建快照，不用手动 `desktop sync`
- [ ] **`purge parity` 增加按层汇总**：不只逐条，给出「哪些层一致 / 哪层缺」
- [ ] **0.21.3 真实样本验证**：找一棵 pristine 0.21.3 树跑 31/31（现在只有 0.21.0 / 0.21.4 实测）
- [ ] **大仓性能**：`purge status` 在 6000+ 行文件上的耗时（现在没量过）
- [ ] **文档**：`docs/troubleshooting.md` 补 3.1.x 遇到的新故障（sentinel / config 叠注释）
