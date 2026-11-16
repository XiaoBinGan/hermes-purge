# Changelog

## 1.0.0

首个可发布版本。

### 清洗器

- 21 条补丁，分三层：提示词（2）、配置（4）、代码（15）
- 目标目录自动探测：`--target` → `HERMES_HOME` → 向上查找 → 常见默认位置
- `--status` / `--apply` / `--verify` / `--revert` / `--uninstall`
- 幂等：二次 `--apply` 改写 0、跳过 21
- 每个被改文件旁生成 `.hermes-purge.bak`，`--revert` 逐个还原
- 版本提醒：锚点验证于 Hermes 0.21.3，目标版本不同时提示 drifted 项需调整

### 破甲执行器

- 三种模式自动判断：`plain`（普通问答，单发不注入）/ `code`（代码，第 2 次起带围栏 prefill）/ `prose`（正文，尺度前置 + seed 续写）
- 判定三态：`ok` / `downgraded` / `refused`，`downgraded` 自动重试，全失败时返回最好的降级版并 exit 2
- 归一化去重：模型复述 prefill 开头时引号会变（直引号 → 弯引号），用只比汉字/字母/数字的方式识别并剥除
- 拒绝不拼前缀：模型守住拒绝时不把代码围栏拼在前面

### 通道

- `api`：直连模型，带 SOUL payload + 尾部 prefill
- `dashboard`：走 Dashboard Chat 同一条 JSON-RPC WebSocket
- `hermes-bin`：`hermes -z` 子进程，带工具

### 边界探针

- 8 类探针（含 1 个对照组），统计单次通过率、拒绝话术归类、`1-(1-p)^6` 收敛期望
- `rescore.js` 可用改过的分类器重评已有样本，不重跑模型

### 工程

- 判定逻辑收敛到 `lib/core.js` 单一来源（此前三份入口各写一份，已漂移过一次）
- 通道收敛到 `lib/channels.js`
- 零硬编码路径
- 36 项冒烟测试，不联网、不改文件

### 已知局限

- 补丁锚点是精确文本匹配，Hermes 升级后会 `drifted`
- 探针只看聊天正文，不看磁盘产物；带工具的 agent 可能已把代码写盘但正文被拒
- 内容层拒绝是采样随机的，`--tries` 是工程收敛手段，不是保证
- 只在 Windows 上实测过
