## hermes-purge 1.1.1

修掉 1.1.0 里一个会**静默废掉最大杠杆**的计数 bug，并把文档追平到代码。

补丁锚点验证于 **Hermes Agent 0.21.3**。共 31 条补丁。

---

### 这个版本修的是什么

`C18` 的拒答重采样计数 `_purge_refusal_nudges` 挂在 agent 对象上，跨轮存活；
而 `HERMES_PURGE_RETRY`（默认 3）的语义是「**每轮**最多重采样几次」。

计数从不按轮清零，于是：

```
turn1 attempt1: 重采样 (counter=1)
turn1 attempt2: 重采样 (counter=2)
turn1 attempt3: 重采样 (counter=3)
turn1 attempt4: 放行 —— counter 停在 3
turn2 attempt1: 放行 —— 一次都不重采样
turn3 attempt1: 放行 —— 一次都不重采样
```

**同一会话里只要有一轮打满 3 次，后面每一轮的第一次判定就是
`used(3) >= cap(3)` → 直接放行。** 重采样杠杆在整条会话里一次性失效。

线上日志佐证：会话 `c0e303` 在 01:59:33 触发 `#1`、02:04:38 触发 `#2`，
02:09 那一轮的拒答就再没有 `#3` —— 计数已经贴在 cap 上。

复现方式（真函数、真模块、假 agent）：

```python
# 同一个 agent 连问三轮，每轮都拒答
from agent.turn_stop_gates import apply_stop_gates
# turn1: 3 次 continue_turn，第 4 次放行，counter=3
# turn2: 第 1 次就放行
# turn3: 第 1 次就放行
```

### 修复

`C18d` — 在 `agent/conversation_loop.py` 的 `run_conversation()` 入口、
`with native_turn_images(user_message):` 之前，插入一行：

```python
agent._purge_refusal_nudges = 0
```

`run_conversation` 是每一轮的唯一入口（`server.py`、TUI、桌面端、ACP 全走它），
所以这一行等价于「cap 按轮，不跨轮」。

### 新增

- **`probe.js --desktop`** —— 按桌面端 surface 建会话（`session.create
  {source:"desktop"}`）。桌面端和 dashboard 是同一个 agent 进程，只 `platform` 与工具集
  不同；带这个开关探出来的数字对两个客户端都成立，不用开图形窗口。明细 JSON 现在记
  `source` 字段（默认 `tui(default)`）。
- `test/c18_unit.py` 增两条结构性断言：reset 行存在、位置在 `_run_conversation_turn`
  调用之前。打回补丁这两条会红。
- `test/smoke.js` 增 C18d 断言，41 项。

### 文档

- README 补齐 C18 / C18b / C18c / C18d / C19b–C19e / C20 / C20b 九条代码补丁明细，
  补丁数 21 → 31，代码层 15 → 25
- README 新增「桌面端与 dashboard 是同一个 agent」一节，链 `docs/desktop-channel.md`
- README **重写「实测数据」**：把「单发 p」和「重试环收敛」拆成两列，删掉会被误读成
  「破甲率 82~100%」的旧表述，并注明桌面端与 dashboard 共用同一组数字
- README「三个有效杠杆」→「六个有效杠杆」，补 C18 与 C20 的实测数据，
  反面结论里补上 `n>1`、换模型、`comboRetryClean` 三条死路
- 目录树补 `c18_unit.py`、`win.ps1`、`drive.ps1`、`docs/`

### 升级

```bash
git pull
node bin/hermes-purge.js --apply      # 只会新改写 conversation_loop.py 一处
node bin/hermes-purge.js --verify
```

**必须重启 Hermes。** `run_conversation` 是模块级函数，进程不重启不重新导入。

```bash
node bin/hermes-purge.js --revert     # 回滚（用 .bak）
```

### 升级后自检

```bash
node test/smoke.js                                        # 41/41
python test/c18_unit.py                                   # 13 项全过
node bin/probe.js --cases=adult --n=12 --desktop          # 桌面端 surface 下的真实基线
```

---

### 完整变更

见 [CHANGELOG.md](../CHANGELOG.md)。