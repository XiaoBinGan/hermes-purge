# Changelog

## 2.1.0 —— adapter 层（引擎与宿主解耦）+ DSH adapter

把「Hermes 专用引擎」拆成「宿主无关引擎 + 可插 adapter」：引擎只认四件事
（cap 清单 / 实现分发 / shim 注入 / 验证），宿主差异全部收进 `adapters/<name>/`。
新增第二个 adapter：DeepSeek Harness（DSH）。**注意：DSH adapter 只有规格与结构验证，
没在真机 DSH 上跑过**（本机无安装），见下。

### 新增

- `lib/v2/adapters.js`：adapter 注册表。`detect(target)` 按目录特征认宿主
  （`hermes_cli/`+`agent/` → hermes；`cordis.patch.yml` 或 `plugins/`+`package.json` 含 dsh → dsh），
  认不出时 CLI 报错并给 `--adapter` 提示，库调用落回 hermes（1.x 兼容）
- `adapters/hermes/`：原 `lib/v2/caps.js` 的 31 条 cap **逐字照搬**（锚点、AST、shim 元数据都没动），
  加上 Python AST / site-packages shim / L1-L3 验证的宿主适配层
- `adapters/dsh/`：40 条 cap（由 dsh-purge 的 88 条按**行为**收敛）：
  approval 10 · guardrail 9 · prompt 8 · config 8 · shim 5；每条约 1–2 条可执行断言
- `lib/v2/conf.js`：配置层 `conf` kind —— `yamlEntry`（cordis.patch.yml 条目按 key 合并、保留其它键）、
  `yamlTop`、`jsonSet`、`jsonAppend`、`fileWrite`；支持一次写同构多文件（web/desktop 两个 profile）
- `lib/v2/shim-node.js`：Node 宿主 shim —— 写 `plugins/dsh-purge/shim/preload.js`（`Module._load` 钩子
  换模块导出）+ 往 `config/launch-env.json` 的 `NODE_OPTIONS` 接 `--require`
- `test/dsh.js`（33 项）+ `test/dsh-fixture.js`：自造 dsh 0.2 布局夹具树（不进仓库），
  验证探测三态、conf/text/shim 落盘、`--adapter` 选择、断言层、revert 逐字节还原（哈希比对）
- `bin/purge.js` 新增 `--adapter=hermes|dsh|auto`（缺省 auto）；`status/apply/verify/revert/doctor`
  全部按 adapter 分发；`doctor` 不再对 DSH 套用 python / site-packages 检查
- `txn.doctor(target, { skip, extra })`：adapter 可以剔除不适用的检查项（默认不传 = 原行为）

### 未验证（如实写）

- **DSH adapter 没在真机跑过。** 无 0.2 安装，验的是结构：夹具树上探测/落盘/回滚/断言。
  未验：DSH 是否真读这些 `cordis.patch.yml` 条目、启动器是否透传 `NODE_OPTIONS`、
  `Module._load` 钩子是否拦得到那些模块。`purge verify --level=3 --adapter=dsh`
  会**如实报「未在真机跑过」并退出 1**，不假装通过
- DSH 的 L1 只做 `node --check` / JSON.parse / YAML 结构检查（零依赖，不做完整 YAML 解析）

### 兼容

- `lib/v2/caps.js` 仍是门面：`buildCaps()`（无参）= hermes 31 条，`filesOf / shimEntriesFor /
  CAP_NAME / AST_CORE / SHIM_CORE` 原样转发
- `bin/hermes-purge.js`（1.x 引擎）未改动
- Hermes 路径回归：真机 `status` 输出与原版**逐字节一致**（31/31 applied）；
  临时 pristine 树 `apply → verify --level=2 → revert` 输出与改前逐字节一致

## 2.0.0 —— capability layer（能力层）

把「补丁集合」升级成「带断言的能力合约」：同一个能力有 AST / shim / 文本 / 配置四条落地路径，
一条失效自动降级；所有写操作走事务；三级验证；内置观测。macOS + Windows 双平台实测。

### 新增

- `bin/purge.js`：v2 引擎。`status / apply / verify / revert / doctor / stats`
- **能力模型**（`lib/v2/caps.js`）：31 条 cap = 行为目标 + 实现链 + 断言。安全核心
  C01–C12 全部有 AST + shim 双路径，结构性改动（C13/C14/C16/C18 系列/C19 系列/C20 系列）
  如实标注为 text-only
- **AST 层**（`lib/v2/ast.js` + `_ast.py`）：按符号名定位函数/类/模块级赋值，改完用宿主
  自己的 python 校验。函数搬家、缩进变化、上游拆模块都不影响
- **shim 层**（`lib/v2/shim.js`）：往 venv site-packages 写 `_hermes_purge.pth` +
  `_hermes_purge_shim.py`，用 meta_path 钩子在模块导入后替换符号。**源码一个字节不改**
  也能让 approval 关死（已实测：pristine 树上只装 shim，`_YOLO_MODE_FROZEN=True`、
  `detect_hardline_command` 返回 `(False, '')`）
- **事务**（`lib/v2/txn.js`）：apply 前全量快照 → 原子写 → manifest 记 before/after 双哈希
  → `revert` 前校验「当前文件 == 我上次写完的样子」，用户手改过就拒绝覆盖（`--force` 才强上）
  → 回滚后逐字节校验；支持按 id 撤到任意历史快照（撤销栈语义）
- **三级验证**（`lib/v2/verify.js`）：L1 `py_compile` + YAML 回读；L2 **行为断言**
  （14 条，直接调用函数，不看源码 —— shim 替换后源码里那条 return 已经不是实际跑的东西）；
  L3 端到端跑一轮
- **观测**（`lib/v2/metrics.js`）：`purge stats` 汇总 cap 命中、impl 分布、拒答命中/收敛、成本
- `test/v2.js`：22 项单元（CRLF/BOM、Win+POSIX 两种 venv 布局、符号定位、AST 幂等、
  shim 模板可解析、事务回滚与漂移拒绝、cap 清单完整性）

### 修复（都是在 Windows 语义下才会炸的坑，已用 CRLF 树实测）

- `_ast.py` 对 CRLF 文件 insert 行会写出 `\r\r\n` → 文件损坏。改为先剥行尾 `\r` 再按原 eol 拼回
- 文本层锚点是按 LF 写的，Windows 的 CRLF 文件会全量 drifted。改为**一律在 LF 视图上匹配与改写**，
  落盘时按文件原 eol 还原
- 快照 id 精确到毫秒会撞车（同一次 apply 里连建两个快照）→ 加随机后缀，快照永不互相覆盖
- `splice/replace` 的 `to` 里含 `find`，重复 apply 会叠两份 → 应用前先看 sentinel，命中就跳过
- shim 模板里 JS 的 `true/false/null` 在 python 里是语法错 → 统一转成 `True/False/None`

### 兼容

- 1.x 的 `bin/hermes-purge.js` 行为不变（照旧吃 `.bak`），与 v2 共用 `lib/patches.js` 的锚点清单
- 0.21.0 与 0.21.3/0.21.4 两套布局都通过：0.21.0 走 18 条变体，0.21.4 走主锚

## 1.2.0

0.21.0 全量兼容，Windows（0.21.3）路径零改动。

### 新增

- **补丁变体（variants）**：每条补丁可带若干「替代文件 + 替代锚点」。主锚优先，
  主锚 `applied`/`pending` 就不试变体 —— Windows 上的判定与替换结果与 1.1.1 逐字一致。
- **0.21.0 变体 18 条**：C04 C05 C06 C11 C12 C13 C14 C16 C18 C18b C18c C18d
  C19b C19c C19d C19e C20 C20b。0.21.0 还没做 0.21.2/0.21.3 的模块拆分
  （approval_context / approval_detection / turn_stop_gates / stream_delivery /
  turn_request_assembly），函数还在 `tools/approval.py`、`agent/conversation_loop.py`、
  `run_agent.py` 里。
- 新 kind：`insertAfterAll`（一次插多处，C06 的三个上下文判定）、`noop`（目标版本已内置，C18）。
- `test/c18_unit_0210.py`：0.21.0 布局下的 15 项断言（函数行为 5 项 + 结构落点 10 项）。

### 修复

- **C14 锚点带缩进**。原锚点在 0.21.3 与 0.21.0 的缩进分别是 8 / 12 空格，旧写法会
  「匹配成功但替换出 `IndentationError`」。现在主锚带 `\n` + 8 空格，12 空格走变体。
- `test/smoke.js` 不再写死 `D:\project\hermes`，改用临时 `HERMES_HOME`；41/41 在 macOS 上成立。
- `lib/core.js` 新增 `configRootOf()`：`readHermesConfig` 会在 `HERMES_HOME` / 父目录里找
  `config.yaml`；找不到时抛 `EHP_CONFIG` 并说明试过的路径，不再冒 `ENOENT`。
- `bin/hp.js` 把配置/环境错误按「环境」处理（退出码 3），不再被重试循环吞成
  「试了 N 次，这一类它不做」——路径错被误报成拒答，会污染 bench 数据。

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
