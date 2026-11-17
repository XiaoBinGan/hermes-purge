# Changelog

## 1.1.1

修掉 1.1.0 里一个会静默废掉最大杠杆的计数 bug，并把文档追平代码。

### 修复

- **C18d：拒答重采样计数按轮重置。** `_purge_refusal_nudges` 挂在 agent 上、跨轮存活，
  但 cap 的语义是「每轮最多重采样几次」。不重置的话，同一会话里只要有一轮打满 3 次，
  后面每一轮的第一次判定就是 `used(3) >= cap(3)` → 直接放行 —— 重采样杠杆在整条会话里
  一次性失效。复现：同一 agent 连问三轮、每轮都拒答，第二轮起一次都不重采样。
- 实测佐证：会话 `c0e303` 在 01:59 和 02:04 各触发一次 `#1`、`#2` 之后，02:09 那一轮
  的拒答没有触发 `#3` —— 计数已经停在 cap 上。

### 新增

- `probe.js --desktop`：按桌面端 surface 建会话（`session.create {source:"desktop"}`），
  探针结果对桌面客户端同样成立，不用开图形窗口。明细 JSON 现在记 `source` 字段。
- `test/c18_unit.py` 增两条结构性断言（reset 行存在、位置在 `_run_conversation_turn` 之前）
- `test/smoke.js` 增 C18d 断言（41 项）

### 文档

- README 补 C18/C18b/C18c/C18d/C19b–C19e/C20/C20b 九条代码补丁明细，补丁数 21 → 31
- README 新增「桌面端与 dashboard 是同一个 agent」一节，链 `docs/desktop-channel.md`
- README 重写「实测数据」：把单发 p 和重试环收敛拆成两列，删掉会被误读成
  「破甲率 82~100%」的旧表述，注明桌面端与 dashboard 共用同一组数字
- README 「三个杠杆」→「六个杠杆」，补 C18 与 C20 的实测数据
- 目录树补 `test/*.ps1`、`docs/`、`c18_unit.py`

## 1.1.0

### 新增

- **C18 / C18b / C18c：拒答在进程内重采样。** 拒答原文不进历史，只往 `messages` 尾部
  追一条 user-role nudge 后重入本轮循环。实测 AMSI 0.63→0.75 单发、3 次重采样后 1.00；
  露骨正文 0.25→1.00。这是目前最大的单一杠杆。
- **C19b–C19e：流式拒答消隐。** 拒答开头的前 80 字符在流式输出里被缓冲掉。纯观感，
  不改成功率。
- **C20 / C20b：采样温度上线路。** `HERMES_PURGE_TEMPERATURE` 直接写进
  `api_kwargs["temperature"]`。配 `reasoning_effort:'none'` 时单发 0.56→0.88（N=16）。
- **`hp --desktop`**：让 dashboard 通道用桌面端的 surface 建会话。
- `docs/desktop-channel.md`：桌面端 attach 证据链。
- `test/win.ps1`、`test/drive.ps1`：窗口枚举 / 焦点 / 截图 / 模拟输入。

### 变更

- `lib/channels.js` 的 `viaDash` 支持 `source` 参数

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
