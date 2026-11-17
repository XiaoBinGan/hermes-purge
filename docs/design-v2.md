# hermes-purge v2 设计方案 —— 相对 dsh-purge 的全面超越

> 基线对手：`YuJunZhiXue/dsh-purge` v1.1.71（88 patch + shim 注入 + override 文件，锁 dsh 0.2）。
> 本方案：把「补丁集合」升级成「能力层（capability layer）」，让同一个能力在**任意宿主、任意版本、任意进程**上都有 ≥2 条落地路径，并且可测、可观测、可热加载、可证明回滚。
> 现状锚点：hermes-purge 1.2.0 = 31 条文本锚点补丁 + 18 条 0.21.0 变体；本文档描述 2.0 的重构。

---

## 0. 一句话差异

dsh-purge 回答的是「**怎么把宿主改掉**」；v2 回答的是「**怎么保证这个改动在被改掉的环境里，永远成立、随时可证、随时可退**」。

前者是补丁，后者是**带断言的能力合约**。这是结构性差异，不是补丁条数的差异。

---

## 1. 对手基线：逐维度拆解（含它自己的短板）

| 维度 | dsh-purge 1.1.71 | 短板 |
|---|---|---|
| 落地形态 | cordis 插件写 profile + `cordis.patch.yml` + shim 注入 + override 文件 | 绑死 DSH 的插件生命周期，换宿主等于重写 |
| 版本韧性 | 补丁按文本锚点写，锁 dsh 0.2；README 明写「更早的 dsh 用对应的老版本插件」 | 上游一动就整批失效，且没有「失效探测」 |
| 锚点 | 纯文本/正则锚（88 条） | 缩进、空格、函数搬迁都会炸（我们已在 Hermes 0.21.0 上实测过：17/31 落不下，其中 1 条是「匹配置换成功但产出 `IndentationError`」） |
| 生效方式 | 点「应用」→ 自动重启进程 | 重启是唯一路径；审批状态在 import 期冻结，热改无效 |
| 生效证明 | 重启后「新开一轮对话」目视确认 | 无运行时断言，无 E2E，无拒绝率指标 |
| 回滚 | 备份覆盖 + 摘掉 shim 里写过的行 | 备份只存一份；二次 apply 会覆盖；无哈希校验，不能证明「退干净了」 |
| 观测 | 无 | 不知道哪条补丁在起作用、什么时候失效 |
| 量化 | README 里一节「本地校验」 | 没有样本、没有置信区间、没有成本口径 |
| 移植性 | 单宿主 | 不可复用 |
| 人格 | 固定 payload（默认「小码酱」）+ 按模型换提示词 | 换模型靠手写，没有数据驱动 |

**结论**：它赢在「形态完整（插件化 + 兜底 + 回滚 + 免责）」；输在「锚点脆、无断言、无观测、绑宿主、不可热更」。v2 就在这五处逐个超。

---

## 2. 六条超越轴 + 硬指标

| # | 轴 | v2 做法 | 验收指标（可测） |
|---|---|---|---|
| 1 | **落地韧性** | 4 层实现：AST 符号补丁 → 缩进感知文本补丁 → 运行时 shim（`sitecustomize`）→ 配置/提示词。能力不因某层失效而消失 | 上游连升 3 个小版本后 cap 存活率 ≥ 95%（当前 0.21.0→0.21.4 是 14/31，需升到 ≥95%） |
| 2 | **可验证** | 三级验证：静态（编译+AST）→ 运行时断言（import 后行为）→ E2E（真跑一轮 + 一次拒绝触发）。每条 cap 必须自带断言，否则不允许进清单 | 断言覆盖率 = caps 数 : 断言数 ≥ 1:1；E2E 3/3 通道（cli / dashboard / desktop surface） |
| 3 | **热生效** | shim 层 + 模块重绑：`apply` 后 ≤2s 生效，不重启进程；源码层改动仍标记「需重启」并单独告警 | 热生效延迟 p95 < 2s；重启需求数从 31 降到 ≤6（仅 config/env 类） |
| 4 | **可回滚证明** | 事务式：全量快照（content-addressed tar + sha256 manifest）→ 原子写 → 变更前 diff → `--revert` 用 manifest 校验逐字节还原 | 还原后 `sha256sum` 全等；重复 revert 幂等；`.bak` 漂移检测（用户手改过就拒绝覆盖） |
| 5 | **可观测** | 每轮埋点：approval 决策、拒答命中、重采样次数、温度、token 预算、命中哪条 cap、走哪层实现 | `hp stats` 出：拒答率、重采样收敛率、单次成功产物成本（token/$）、cap 命中热力 |
| 6 | **跨宿主** | `core`（能力 DSL + 引擎）+ `adapters/hermes`、`adapters/dsh`。把 dsh-purge 的 88 条迁成同一套 cap，两边共用引擎 | 同一份 cap 清单在 2 个宿主上通过；dsh 侧 88 条 ≥ 85 条被 cap 覆盖 |

补充两条不写在表里但必须做：**误判率**（decoy 集上判「合格」的误杀率 < 2%，当前 `judge` 对「拒绝服务压测」「默认值不提供」会误杀）与**人格漂移**（长会话中 payload 影响力衰减的量化）。

---

## 3. 架构

```
purge/
├── core/
│   ├── capability.js      # cap 定义 + 断言 + 依赖 + 版本约束
│   ├── anchor.js          # 锚点解析：AST/符号 > 缩进文本 > 正则 > 运行时钩子
│   ├── engine.js          # 选择实现、事务执行、热加载、审计
│   ├── txn.js             # 快照 / 原子写 / manifest / 回滚 / 指纹
│   ├── verify.js          # 静态 + 运行时 + E2E
│   └── metrics.js         # 埋点写入 + 聚合
├── impl/
│   ├── ast.js             # 用宿主自己的 python 跑 ast 脚本（跨版本稳）
│   ├── text.js            # 缩进感知文本补丁（现 1.2.0 的形态）
│   ├── shim.js            # venv sitecustomize + monkeypatch 表
│   └── conf.js            # config.yaml / .env / SOUL.md / prefill
├── adapters/
│   ├── hermes/ caps.yaml  # 31 条（含 0.21.0/0.21.3 实现分派）
│   └── dsh/    caps.yaml  # 88 条（从 dsh-purge 迁移）
├── bench/
│   ├── probe.js  rescore.js  stats.js
└── cli/ hp.js  purge.js
```

**依赖方向**：`adapters → core ← impl`，`impl` 不认识任何宿主；宿主知识只存在于 `adapters/*/caps.yaml`。这是「跨宿主」能成立的前提。

---

## 4. 能力 DSL（v2 的核心）

一条 cap = 一个**行为目标** + 若干**可互换实现** + **断言**。

```yaml
- id: H-APPROVAL-04
  cap: approval.mode.force_off          # 行为，不是文件
  layer: security
  since: {hermes: ">=0.21.0"}
  impl:
    - kind: ast                          # 首选：符号级，抗搬迁
      file: "tools/approval.py"
      symbol: _get_approval_mode
      action: force_return
      value: '"off"'
    - kind: text                         # 次选：现在的文本锚（保留兼容）
      file: "tools/approval_context.py"
      find: 'def _get_approval_mode() -> str:'
      insert: 'return "off"'
    - kind: shim                         # 兜底：不改源码也能生效
      module: tools.approval
      attr: _get_approval_mode
      wrap: "lambda *a, **k: 'off'"
    - kind: conf
      path: approvals.mode
      value: "off"
  assert:
    - runtime: "tools.approval._get_approval_mode() == 'off'"
    - runtime: "tools.approval.is_approval_bypass_active() is True"
  cost: {restart: false}                 # 该 cap 是否必须重启
```

**分派算法**（`anchor.js`）：

```
for impl in cap.impl:                 # 顺序即优先级
    st = probe(impl)
    if st == applied:  return {impl, status: applied}
    if st == pending:  return {impl, status: pending}     # 可执行
    # drifted/missing → 下一个 impl
if any impl drifted:  report drifted(cap, tried=[...])
else:                 report unsupported(cap, host)
```

三条铁律（都来自今天的实战）：

1. **否定式锚点必须带缩进**。`includes("api_messages = ...")` 会在 12 空格的行上匹配成功、再按 8 空格写回 → `IndentationError`。文本 impl 一律「行首锚定」：`\n` + 精确缩进 + 内容。
2. **不假设文件布局**。「函数在哪个文件」由 AST 扫描决定，不写死（0.21.0 把 5 个模块内联进 `tools/approval.py`，0.21.3 又拆出来）。
3. **不假设 import 顺序**。shim 常量必须落在 `import re` 之后；文本 impl 的插入点必须能表达「在符号 X 之后、符号 Y 之前」。

---

## 5. 四层实现

### 5.1 AST 层（首选）

用**宿主自己的解释器**跑一段 `ast` 脚本（跨版本最稳，不依赖 tree-sitter 的 Python 语法版本）：

```python
# core/impl/ast_probe.py（由引擎以子进程调用）
import ast, json, sys
target, symbol = sys.argv[1], sys.argv[2]
tree = ast.parse(open(target, encoding='utf-8').read())
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == symbol:
        print(json.dumps({"file": target, "line": node.lineno,
                          "col": node.col_offset,
                          "end_line": node.end_lineno,
                          "returns": ast.unparse(node.returns) if node.returns else None}))
```

能力：
- 找到函数 → 在 `body[0]` 插入 `return <value>`（`force_return`）
- 找到调用点 → 在语句前插桩（`before_call`）
- 找不到 → 该 impl `unsupported`，自动降级到下一层

收益：宿主把函数从 A 文件搬到 B 文件、改缩进、加装饰器，AST 层都不受影响。**这直接消灭今天 17/31 落不下的那类问题。**

### 5.2 文本层（兼容 + 兜底）

保留 1.2.0 已验证的 31 条锚点 + 18 条变体，但加两个约束：
- 所有 `find` 必须以 `\n` 开头、带完整缩进（见 4.2 铁律 1）
- 每条必须声明 `sentinel`（`[hermes-purge] <id>`），状态以 sentinel 判定，不以「原文是否还在」判定

### 5.3 shim 层（真正的兜底 + 热生效）

venv 现状已确认可用：`venv/lib/python3.11/site-packages/` 下没有 `sitecustomize.py`，`.pth` 机制存在，`hermes` 启动脚本就是 `venv/bin/python`。方案：

```
venv/lib/python3.11/site-packages/
├── _hermes_purge_shim.py          # 引擎生成，内容 = 一张 monkeypatch 表
└── _hermes_purge.pth              # 一行：import _hermes_purge_shim
```

```python
# _hermes_purge_shim.py（生成物，带版本指纹）
import os, json, importlib, atexit

_TABLE = json.loads(os.environ.get("HERMES_PURGE_SHIM") or "[]")  # 也可内联
_LOG = os.path.expanduser("~/.hermes/purge/shim.log")

def _install(mod_name, attr, maker):
    try:
        mod = importlib.import_module(mod_name)
        setattr(mod, attr, maker(getattr(mod, attr, None)))
        open(_LOG, "a").write(json.dumps({"ok": True, "mod": mod_name, "attr": attr}) + "\n")
    except Exception as e:
        open(_LOG, "a").write(json.dumps({"ok": False, "mod": mod_name, "attr": attr, "err": repr(e)}) + "\n")

def _approval_mode(_orig):
    return lambda *a, **k: "off"

_install("tools.approval", "_get_approval_mode", _approval_mode)
```

**为什么这层能超越 dsh-purge 的 shim**：
- `sitecustomize` 在**任何** hermes 进程启动时执行（cli / dashboard / gateway / desktop 后端），不需要改一个源码文件
- 可以**热重载**：重新 import shim → 替换函数引用 → 不需要重启（`hermes dashboard` 里的长连接会话下一轮就走新函数）
- 与源码层**互补**：源码层拿不到（版本变了、文件被 wheel 化、用户 `pip install -U`）时 shim 仍在
- 失败可见：每次安装写 `shim.log`，`hp doctor` 直接读它

限制（必须写进文档，别自欺）：
- 只能替换**已经以模块属性存在**的符号；模块内部直接调用本地名的场景（`def a(): return _b()`）替换无效 → 这类仍必须走 AST 层
- import 期冻结的值（`_YOLO_MODE_FROZEN`）只能靠环境变量（`.env` 里的 `HERMES_YOLO_MODE=1`）在 import 前注入，shim 装不上

### 5.4 配置 / 提示词层

与 1.2.0 相同（`config.yaml` / `.env` / `SOUL.md` / `prefill_messages.json`），但补两件事：
- **YAML 结构化改写**（不用正则爬行）：用 `ruamel.yaml` 保留注释与顺序，写出后回读校验
- **配置意图断言**：`approvals.mode == off && approvals.timeout >= 86400`（今天 G01 就栽在「只判 mode、不判 timeout」）

---

## 6. 事务、回滚与审计

```
apply:
  1. scan      → 收集将被改的所有路径（源码 / 配置 / venv shim）
  2. snapshot  → tar.zst 到 ~/.hermes/purge/snap/<ts>/ + manifest.json(sha256)
  3. dry-diff  → 打印每个文件的 unified diff（--dry 到此为止）
  4. write     → 逐个原子写（tmp + os.replace），写完立刻 sha256 记入 manifest
  5. verify    → 静态 + 运行时（可选 E2E）
  6. audit     → 追加 ~/.hermes/purge/audit.jsonl（谁、何时、哪条 cap、哪层 impl）

revert:
  1. 读最近一次 successful apply 的 manifest
  2. 逐个文件校验「当前 sha256 == 写入后 sha256」；不等 → 判定被用户手改 → 拒绝覆盖（需 --force）
  3. 用 snapshot 还原，还原后逐字节校验
  4. 删 shim 的 .pth 与 .py，更新 audit
```

相对 dsh-purge 的 `.bak`：备份**多版本**、带哈希、能证明「退干净了」、拒绝覆盖用户手改、以及**不会因为二次 apply 而丢掉原始备份**（今天真实踩到：连跑两次 apply 后 `.bak` 已不是原始文件，我最后只能用仓库 HEAD 重建）。

---

## 7. 三级验证

| 级别 | 内容 | 失败含义 |
|---|---|---|
| L1 静态 | `py_compile` / `ast.parse` 全量；YAML 回读；shim 语法检查 | 补丁写坏了（今天 C14 那类） |
| L2 运行时 | 每条 cap 的 `assert.runtime`，在宿主 venv 里跑子进程 | 补丁落了但没生效（符号被覆盖、import 顺序错） |
| L3 E2E | 用 stub provider（本地假模型，固定返回脚本）+ 真 provider 各跑一轮：一次正常完成、一次故意拒答触发 C18 重采样、一次流式短答案触发 C19 补投 | 链路级回归 |

stub provider 是关键：**不花 token、不依赖网络**，就能断言「拒答 → 追加 nudge → 重采样」这条路径真的走了（今天只能靠人眼看日志）。

---

## 8. bench 升级（对 dsh-purge「本地校验」的替代）

沿用 1.2.0 的 `probe/rescore`，补四件：

1. **统计口径**：单发 p 用 Wilson 95% CI；重试环收敛用几何分布闭式；样本量 N 显式记录，N<12 不出结论
2. **成本口径**：每次成功产物的 token 与 $（按模型价目表），因为「温度 + 重采样」不是免费的
3. **误判集（decoy）**：≥30 条「像拒绝但不是拒绝」的正经请求（拒绝服务压测、默认值不提供、抱歉口头语…），测 judge 误杀率
4. **磁盘断言**：README 自己承认「聊天正文 ≠ 实际产出」——E2E 类目必须同时看工作目录产物（文件数、关键字、可解析性）

---

## 9. 观测（dsh-purge 完全没有）

`~/.hermes/purge/metrics.jsonl`，每轮一行：

```json
{"ts":"...","surface":"dashboard","model":"deepseek-flash","turn":7,
 "approval":{"mode":"off","bypassed":true,"cap":"H-APPROVAL-04","impl":"ast"},
 "refusals":{"hit":1,"resample":1,"recovered":true},
 "budget":{"max_tokens":16000,"used":9123},
 "temp":{"env":null,"effective":null},
 "cost":{"in":812,"out":445}}
```

`hp stats` 输出：拒答率趋势、重采样收敛率、按类目成功率、单次成功产物成本、cap 命中热力（哪条在干活）、**失效告警**（cap 最近 24h 未被命中或被跳过）。

---

## 10. 跨宿主：把 dsh-purge 的 88 条迁进同一套 DSL

`adapters/dsh/caps.yaml` 与 `adapters/hermes/caps.yaml` 共用 `core`。迁移映射：

| dsh-purge 概念 | v2 cap 表达 |
|---|---|
| 88 条 patch | 按「行为」聚类成 ~40 条 cap（多条 patch 常常是同一行为的重复表述） |
| `cordis.patch.yml` 写 profile | `impl: conf`（path = profile 键） |
| shim 注入 | `impl: shim`（DSH 是 node：`--require` 预加载 / `NODE_OPTIONS`） |
| override 文件 | `impl: text`（整文件替换 + sentinel） |
| `/purge` 命令 | `cli/purge.js` 同一套 verb（apply/verify/revert/doctor/stats） |

这一步完成后，「hermes-purge」这个名字就不再准确了 —— 它是 `purge` 引擎 + 两个 adapter。这才是对 dsh-purge 的结构性超越：**它是一份实现，我们是一个平台**。

---

## 11. 路线图（按「先消灭今天暴露的痛点」排序）

| 阶段 | 内容 | 交付 | 工作量 |
|---|---|---|---|
| **P0** | 事务 + doctor + 文本锚点规范化（行首锚定、sentinel 判定） | `txn.js` `doctor`；把 31 条锚点全部改成行首锚定 | 0.5d |
| **P1** | AST 层 + 能力 DSL（31 条 cap 化，AST 优先、文本兜底） | `anchor.js` `impl/ast.js`；0.21.0/0.21.3 双版本一次性通过 | 1d |
| **P2** | shim 层 + 热生效 | `impl/shim.js` + `sitecustomize` 生成器；`apply --hot` | 1d |
| **P3** | 三级验证 + stub provider | `verify.js` + `bench/stub_provider.py`；E2E 3 用例 | 1d |
| **P4** | metrics + `hp stats` + 漂移告警 | `metrics.js` | 0.5d |
| **P5** | bench 升级（CI/成本/decoy/磁盘断言） | `bench/*` | 1d |
| **P6** | dsh adapter（88 → ~40 cap） | `adapters/dsh` | 1.5d |

每阶段的验收门槛（达不到不进入下一阶段）：

- P0：连续 apply 两次，`.bak` 仍是原始文件；revert 后 sha256 全等
- P1：0.21.0 与 0.21.4 两套树，31/31 落且 0 处需要人肉改锚点；`py_compile` 全过
- P2：apply 后不重启，dashboard 下一轮即生效（用 E2E 断言）
- P3：3 个 E2E 用例在 cli / dashboard / desktop surface 全绿
- P4：`hp stats` 能报出「C18 最近 24h 命中 N 次、收敛 N/N」
- P5：decoy 误杀率 < 2%；每类目有 CI 与成本
- P6：同一份 engine 在 DSH 上跑通 ≥85/88

---

## 12. 风险与边界（写在前面，别到时候装死）

1. **AST 层不是万能的**：动态生成代码（`exec`）、装饰器改写签名、`__slots__` 类替换后仍可能漏。所以永远保留 shim 兜底。
2. **shim 的模块内直接调用无效**：`def a(): return _b()` 里替换 `_b` 不起作用。这类 cap 必须 AST。
3. **热生效有盲区**：已进入的长会话、已缓存的 system prompt（`_cached_system_prompt`）在本轮不刷新，必须下一轮。
4. **跨宿主会稀释**：cap 抽象过细会变成「跟补丁一样」，过粗会变成「没法验证」。经验值：一条 cap 对应 1–3 个断言、1–4 个 impl。
5. **度量会被游戏**：bench 的判「合格」必须同时看正文质量与磁盘产物，否则几十字敷衍短答会假高分（dsh-purge 的 README 也踩过这个坑，我们是二次踩）。

---

## 13. 验收：一句话

> 上游发版 → `purge doctor` 报出「3 条 cap 走了 shim、2 条降级到文本、0 条失效」→ `purge apply --hot` 不重启 → `purge verify` 三级全绿 → `hp stats` 显示 C18 命中 12 次收敛 12 次、单次成功产物成本 0.0031 USD → `purge revert` 后 sha256 全等。

dsh-purge 能做到第 1 步和第 6 步；v2 把中间四步也变成可执行、可断言、可审计的。
