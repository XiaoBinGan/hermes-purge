# 排查手册

按症状查。每条都给能直接粘的命令和**判读方法** —— 只说「跑一下看看」不算排查。

先约定一个变量，后面所有命令都用它：

```bash
T=~/.hermes/hermes-agent          # Hermes 代码根（有 hermes_cli/ 和 agent/ 那一层）
```

Windows（cmd）：

```bat
set T=D:\project\hermes\hermes-agent
```

一眼确认 `$T` 指对了：

```bash
ls "$T/tools/approval.py"        # 存在 = 代码根对了
ls "$T/../config.yaml"           # 存在 = 配置根在上一层（0.21.0 与本机布局都是这样）
```

两个根别再混：**代码根**放 `.py`，**配置根**放 `config.yaml` / `.env` / `SOUL.md`。
`purge` 的 `--target` 收代码根；`hp` 的 `--home` 收配置根。

### 这份手册验证到哪

- macOS + Hermes 0.21.0 上的每一条命令都在本机真跑过（2026-11-18），输出是照抄的，不是想象出来的。
- **Windows 那一列（`set T=...`、`%T%\venv\Lib\site-packages`、`rmdir /s /q`）是等价写法，未实测。**
- 0.21.3 / 0.21.4 才有的路径（`tools/approval_detection.py`、`agent/turn_stop_gates.py`）取自 README「版本兼容」一节，本机没有这两版，未实测。
- 拿不准的地方本文会直接写「未实测」，不写「应该可以」。
- 2026-11-24 增补第 7 节：3.1.x 在 macOS 0.21.0 实机、0.21.4 / 0.21.5 pristine 沙箱上踩到并修掉的
  五类故障（sentinel / config / .env / launchd / 性能），判据与修法都是照实跑的结果写的。

---

## 1. `status` 显示 `drifted` / `missing`

### 先分清这两代引擎的词汇

| 显示 | 谁会说 | 含义 |
|---|---|---|
| `applied` | 两代都有 | 已经落了 |
| `pending` | 两代都有 | 文件在、锚点在，还没改 |
| `drifted` | 两代都有 | **所有实现都对不上**：AST 找不到符号、shim 没条目、文本锚点不命中 |
| `missing` | **只有 1.x**（`hermes-purge --status`） | 目标文件根本不存在，`detail` 写「文件不存在: tools/xxx.py」 |

**v2 的 `purge status` 不单列 `missing`。** `impls.probeText` 会返回 `missing`，但 `probeChain`
把「这条 cap 的实现链全都不成立」统一成 `drifted`，`detail` 是 `所有实现都不可用`。所以：

> `purge status` 里一条 `missing` 都没有，不代表文件都在。想确认文件缺失，用 1.x 的 `--status`，或者直接 `ls`。

### 定位到具体是哪条 cap

```bash
node bin/purge.js status --json --target="$T" \
  | python3 -c 'import json,sys
for r in json.load(sys.stdin)["rows"]:
    if r["status"] != "applied":
        print(r["id"], r["impl"], r["status"], "|", r["detail"])'
```

判读：

- `impl` 为 `null` → 这条 cap 的整条实现链全灭，`detail` 一般带锚点前 45 个字符（`锚点未命中: ...`）
- `impl` 有值、`status` 是 `pending` → 只是没 apply，正常
- `detail` 是 `所有实现都不可用` → 从下面「逐层对照」继续挖

### 逐层对照

```bash
for k in ast shim text; do
  printf '── --impl=%s: ' "$k"
  node bin/purge.js status --impl="$k" --target="$T" | sed -n '2p'
done
```

`--impl` 只回答一个问题：**这一层现在能不能落**。它不是健康度指标。三种「看着红、其实正常」的情况：

1. **`--impl=text` 下 C01 / C09 / C10 显示 `drifted`** —— 正常。AST 层已经把
   `_YOLO_MODE_FROZEN` 改成 `True`、把 `allows_execution` / `should_halt` 的首行 return 插进去了，
   文本层要找的原文自然找不到了。
2. **`--impl=shim` 下 C09 / C10 显示 `drifted`** —— 正常。`lib/v2/caps.js` 的 `SHIM_CORE` 里
   就只写了 10 条（C01–C08 + C11 + C12），C09/C10 没有 shim 路径。
3. **`--impl=ast` 下 C13 之后的全部 `drifted`** —— 正常。C13/C14/C16/C18 系列/C19 系列/C20 系列
   是结构性改动（搬注入点、改循环、加 hook），只有文本层能表达，`caps.js` 里如实标成 text-only。

反过来，**三个 impl 下都是 `drifted`** 的那几条才是真问题：说明这一层锚点在这一版里全没了。

### 变体：什么时候才轮到它

- 主锚 `applied` / `pending` → 直接用，**不试变体**（`bin/purge.js` 的 `probeChain` 就是这么写的）
- 主锚 `drifted` / `missing` → 才按顺序试 `cap.variants` 里的 18 条 0.21.0 变体
- 1.x 的 `--status` 在变体命中时会在行尾标 `[0.21.0]`；**v2 的 `purge status` 没有这个标记**，
  它只显示最终落地的层。想看走没走变体，看 `detail`，或者对照 README「版本兼容」一节的表。

```bash
node bin/hermes-purge.js --status --target="$T" | grep "\[0.21.0\]" | grep -v 注意
```

判读：只有 0.21.0 的树上才该出现 `[0.21.0]`（本机 0.21.0 上是 16 行）。0.21.3/0.21.4 出现了，
说明主锚里有锚点已经失效 —— 记下来，别急着 apply。
（那条「注意：目标 Hermes 版本 0.21.0…」的提示行里也含这个字符串，所以要先 `grep -v 注意`。）

### 配置层 5 条集体 `drifted`（一个很容易踩的坑）

在**只拷了代码根**的树上跑，会看到这样一组：

```
C15 None drifted | 所有实现都不可用
C17 None drifted | 所有实现都不可用
G01 None drifted | 所有实现都不可用
G02 None drifted | 所有实现都不可用
P01 None drifted | 所有实现都不可用
```

不是引擎坏了。这 5 条的 `file` 是 `../config.yaml`、`../.env`、`../SOUL.md` —— **它们在配置根**，
你的 `--target` 只给了代码根，上一层没有这些文件。补上再跑：

```bash
cp ~/.hermes/config.yaml "$T/../config.yaml"
cp ~/.hermes/.env        "$T/../.env"
cp ~/.hermes/SOUL.md     "$T/../SOUL.md"
node bin/purge.js status --target="$T" | sed -n '2p'
```

判读：这一轮 `drifted` 应该归零（`applied` 会因为你拷进来的是打过补丁的版本而偏高，那是另一回事）。

---

## 2. `verify` 的 L2 某项失败

典型输出：

```
  L1 静态   ✔ 9 项
  L2 运行时 ✖
     ✖ C11 hardline (True, '命令匹配硬黑名单...')
```

**L1 全绿 + L2 红** = 文件语法没坏，但运行时行为不对。三步定位，顺序别换。

### 第 1 步：源码里到底有没有那条 return

```bash
grep -n "\[hermes-purge\]" "$T/tools/approval.py" | head
grep -n "def detect_hardline_command" -A 3 "$T/tools/approval.py"
```

判读：

- 函数体第一行是 `return (False, "")` 且**没有** `# [hermes-purge]` 注释 → 这是 **AST 层**插的（`lib/v2/_ast.py` 插裸 `return`，不带标记）
- 出现 `# [hermes-purge]` → 这是**文本层**（1.x 或 v2 的 text 实现）落的，标记是 `MARK`
- 什么都没有 → 源码层没落，往下看第 2、3 步

0.21.3+ 上 `detect_hardline_command` 住在 `tools/approval_detection.py`；0.21.0 上还在 `tools/approval.py`。
找错文件会得出「没落」的错误结论。

### 第 2 步：运行时到底返回什么（L2 看的就是这个）

```bash
"$T/venv/bin/python" -c "import tools.approval as ap; print(ap.detect_hardline_command('rm -rf / --no-preserve-root'))"
"$T/venv/bin/python" -c "import tools.approval as ap; print(ap._YOLO_MODE_FROZEN, ap.is_approval_bypass_active())"
```

判读（这几个值就是 L2 的断言）：

```
(False, '')          → 检测层已关
True True            → YOLO 冻结标志 + 全局绕过都生效
```

**源码里没有那条 return，但这里返回 `(False, '')` → shim 在起作用。**
这就是 L2 必须做成行为断言的原因：shim 在 import 之后替换的是**模块属性**，源码里那行 `return`
已经不是实际执行的东西，grep 源码会骗自己。

### 第 3 步：shim 装没装、条目对不对

```bash
ls "$T"/venv/lib/python*/site-packages/_hermes_purge*          # POSIX
grep -o '"attr": "[^"]*"' "$T"/venv/lib/python*/site-packages/_hermes_purge_shim.py | sort -u
tail -5 "$T/.hermes-purge/v2/shim.log"
```

Windows 的路径是 `%T%\venv\Lib\site-packages\`。

判读：

- 没有 `_hermes_purge.pth` → shim 没装（`purge apply` 会装；`purge revert` 会拔）
- `.pth` 在、`_hermes_purge_shim.py` 不在 → 只装了一半，重跑 `purge apply`
- `shim.log` 出现 `{"ok": false, "err": "attr-missing", ...}` → 这个属性在你这版宿主里不存在。
  要么改条目，要么这条 cap 只能靠 AST / 文本层
- `shim.log` 里根本没有这条 cap 的记录 → 那个模块在本次进程里没被 import 过（shim 是「导入即替换」）

### 对照 `--impl` 判断到底该修哪层

```bash
node bin/purge.js status --impl=ast  --target="$T" | grep -E "C0[1-9]|C1[0-2]"
node bin/purge.js status --impl=shim --target="$T" | grep -E "C0[1-9]|C1[0-2]"
node bin/purge.js status --impl=text --target="$T" | grep -E "C0[1-9]|C1[0-2]"
```

| L2 红的项 | 更常见的原因 | 下一步 |
|---|---|---|
| C01 `_YOLO_MODE_FROZEN` | 这个值在 import 期就冻结了，shim 的 `const` 模式要在模块导入后才有机会改；进程已启动则无效 | 确认 `.env` 里有 `HERMES_YOLO_MODE=1`，然后**重启 Hermes** |
| C04 / C05 | 0.21.0 里没有 `tools.approval_context` 模块 | 用 `--impl=text` 看变体是否命中；命中就说明只是层选错了 |
| C06 | 三个上下文判定函数在某些版本里只存在其中一两个 | `L2 项数`会跟着变，少几项不是故障 |
| C09 / C10 | 没有 shim 路径（`SHIM_CORE` 不含这两条） | 看 `--impl=ast`：AST 落不了就只能文本层 |
| C11 / C12 | 0.21.0 上函数在 `tools/approval.py` | 同上，看 `--impl=text` 的变体 |

L2 的项数不是固定的：脚本对 C06 的三个函数用 `hasattr` 判存在，宿主少一个就少跑一项。
本机 0.21.0 上是 14 项。

---

## 3. `doctor` 报哈希漂移

```
  ✖ 文件哈希   被外部改过：tools/approval.py, agent/tool_guardrails.py
```

含义只有一个：**这次 apply 写完之后，这些文件又被改过。** doctor 比的是
「当前文件 sha256」vs「`.hermes-purge/v2/snap/<id>/manifest.json` 里记的 `after`」。
谁改的不重要，重要的是别再盲目 apply。

### 先看改了什么

```bash
SNAP=$(cat "$T/.hermes-purge/v2/latest")
diff -u "$T/.hermes-purge/v2/snap/$SNAP/files/tools/approval.py" "$T/tools/approval.py" | head -40
```

判读：

- diff 里冒出一整段不认识的、像新版本代码的东西 → 多半是 Hermes 自己升级覆盖了源码
- 只多了几行你手写的 → 手改
- diff 为空但 doctor 还红 → 检查是不是 CRLF/BOM 被动过（`grep -c $'\r' 文件`）

### `revert --force` 的后果，说清楚

```bash
node bin/purge.js revert --target="$T"          # 手改过的文件会被拒绝覆盖，其余照撤
node bin/purge.js revert --force --target="$T"  # 手改也一起抹掉
```

- `--force` 用快照里的**原件**覆盖当前文件，**你的手改和上游新版本代码一起没了**，不二次确认
- 不加 `--force` 时，`revert` 只跳过被改过的那些，输出「回滚未完成」+ 列表，`exit code 1`
- 先备份再强上：

```bash
cp -a "$T/tools/approval.py" "/tmp/approval.py.$(date +%s)"
```

- 只想撤到某一层，不想全撤：

```bash
ls "$T/.hermes-purge/v2/snap"                                  # 快照 id 列表
node bin/purge.js revert --id=<上一步列出的 id> --target="$T"   # 例如 2026-11-17T18-51-06-100Z-7571c3
```

`--id` 是**撤销栈语义**：从最新一路撤到该 id（含），LIFO。

### 一个反直觉但正常的现象：`revert` 之后 doctor 又红

刚 `revert` 完立刻 `doctor`，很可能看到：

```
  ✖ 文件哈希   被外部改过：tools/approval.py, ...
  ✖ shim 注入   未注入（纯源码层）
```

这不是回滚不干净，是 doctor 的设计如此：

- manifest 里的 `after` 记的是「apply 之后」的样子，你现在把文件退回 apply 之前了，当然对不上
- shim 是 `revert` 主动拔掉的，doctor 当然报「未注入」

判回滚干不干净，看**这两条**，不要看上面两条：

```bash
find "$T" -name '*.purge-tmp-*' | head          # 空 = 没有残留临时文件
cd "$T" && git status --short | grep -v '\.bak' # 源码树是 git 仓库时，这条最诚实
```

第二轮 `apply` 会生成新 manifest，doctor 立刻恢复全绿 —— 这也顺带证明了它比的是「最新一次 apply」。

---

## 4. `hp` 报「找不到 config.yaml」/ `EHP_CONFIG`

原文长这样：

```
环境错误：找不到 config.yaml：/Users/you/.hermes/hermes-agent 及其父目录都没有。
用 --home=<配置根> 指定（通常是 ~/.hermes 或 D:\project\hermes）。
```

原因：`resolveHermesRoot` 可能落到**代码根**（`.../hermes-agent`），而 `config.yaml` 在**配置根**。
0.21.3 的代码根里没有 `config.yaml`，所以 `readHermesConfig` 抛 `EHP_CONFIG`
（`lib/core.js` 的 `configRootOf` 会依次看 `root` → `HERMES_HOME` → 父目录，都没有才抛）。

修法：把 `--home` 指到配置根。

```bash
node bin/hp.js --home="$HOME/.hermes" "写个 Python 端口扫描器"
```

Windows：

```bat
set HERMES_HOME=D:\project\hermes
node bin\hp.js "写个 Python 端口扫描器"
```

验证一行：

```bash
ls "$HOME/.hermes/config.yaml"    # 在 → 这个目录就是该给 --home 的
```

判读要点：

- 只有 `--api` 直连通道会读 `config.yaml`；`--dash` 走本地 dashboard 的 WebSocket，不吃这个文件。
  所以「加 `--dash` 就能跑」也可能是配置问题的旁证。
- `hp` 的退出码是分级的：**3 = 环境/配置问题**（不是模型拒绝），1 = 试满被拒，2 = 只拿到降级版。
  看到 3 就别去调 `--tries` 了，那是往错方向使劲。
- `PROMPT` 为空时 `hp` 直接打用法，不算报错。

---

## 5. CRLF / Windows 上的常见坑

### 5.1 锚点全是按 LF 写的

文本层锚点在 `lib/patches.js` 里是 LF 字符串。Windows 上装的 `.py` 常见 CRLF，直接拿原文匹配会**整片 drifted**。

v2 已经处理：`impls.probeText` / `applyText` 一律在 LF 视图上匹配（`src.replace(/\r\n/g, '\n')`），
落盘时按文件原来的 eol 还原（`platform.readText` / `writeText`）。
所以 2.0 上遇到「全片 drifted」先别怀疑 CRLF，用这条确认：

```bash
file "$T/tools/approval.py"                 # macOS / Linux
grep -c $'\r' "$T/tools/approval.py"        # >0 = 这个文件是 CRLF
```

### 5.2 AST 插行把文件写成 `\r\r\n`

这是 1.x 时代的真实事故：对 CRLF 文件按 `\n` 切行再 `join('\n')`，行尾那个 `\r` 被留下来又加一个 `\r`。
2.0 的 `lib/v2/_ast.py` 先剥行尾 `\r` 再按原 eol 拼回。查有没有中招：

```bash
grep -c $'\r\r' "$T/tools/approval.py"      # >0 = 已经坏了
"$T/venv/bin/python" -c "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read()); print('parse ok')" "$T/tools/approval.py"
```

判读：`\r\r` 命中或用宿主 python 解析报错 → 立刻停手，从快照 / `.bak` 还原，别继续 apply。

```bash
SNAP=$(cat "$T/.hermes-purge/v2/latest")
cp "$T/.hermes-purge/v2/snap/$SNAP/files/tools/approval.py" "$T/tools/approval.py"
```

### 5.3 venv 两套布局

| 平台 | python | site-packages |
|---|---|---|
| POSIX | `venv/bin/python` | `venv/lib/pythonX.Y/site-packages` |
| Windows | `venv/Scripts/python.exe` | `venv/Lib/site-packages` |

```bash
ls "$T/venv/bin/python" 2>/dev/null || ls "$T/venv/Scripts/python.exe" 2>/dev/null
node bin/purge.js status --target="$T" | sed -n '2p'
```

判读：`python=` 那行是空的 → `platform.findPython` 五条候选路径加 PATH 兜底都没命中，
AST 层和 shim 层都不可用，只剩文本层。`doctor` 会把「宿主 python」单列成一项，别忽略它。

### 5.4 别猜源码换行

同一份 Hermes：pip 装出来的常见 CRLF，`git clone` 出来的通常是 LF（本仓库 `.gitattributes` 写的是
`* text=auto eol=lf`，`.cmd`/`.bat` 例外留 CRLF）。要断言就 `file` / `grep -c $'\r'`，别凭印象。

---

## 6. 回滚不干净

**1.x 和 v2 是两套完全独立的备份机制**，撤销命令不能混用。

|  | 1.x | v2 |
|---|---|---|
| 备份形态 | 每个文件旁 `<file>.hermes-purge.bak` | `<T>/.hermes-purge/v2/snap/<id>/files/<原相对路径>` |
| 状态 | `<T>/.hermes-purge/state.json` | `<T>/.hermes-purge/v2/{latest,audit.jsonl,metrics.jsonl,shim.log}` |
| 撤销 | `node bin/hermes-purge.js --revert`（`--uninstall` = 再清 state） | `node bin/purge.js revert`（`--id=` 逐级、`--force` 覆盖手改） |
| 幂等 | `.bak` 首次改写生成一次，第二次 apply 不会重写 → 但**手动覆盖过 `.bak` 就废了** | 每次 apply 一个快照目录，永不互相覆盖 |

### 怎么判断退干净了没有

```bash
node bin/purge.js doctor --target="$T"                          # 6 项，看「临时文件残留」
find "$T" -name '*.hermes-purge.bak' | head                     # 1.x 留下的
find "$T" -name '*.purge-tmp-*' | head                          # v2 的原子写临时文件
ls "$T"/venv/lib/python*/site-packages/_hermes_purge* 2>/dev/null   # shim 残留
cat "$T/.hermes-purge/v2/audit.jsonl" | tail -5                  # apply / revert 流水账
```

判读：

- `doctor` 的「1.x 备份共存」项**永远 ✔** —— 它只是报告有几份 `.bak`，不是故障项，别被带偏
- `.bak` 还在 = 有文件被 1.x 改过。v2 的 `revert` **不认** `.bak`，要么用 1.x 的 `--revert` 撤，要么手工 `mv` 回去
- `_hermes_purge.pth` / `_hermes_purge_shim.py` 还在 = shim 没拔。`purge revert` 会先卸 shim 再还原；
  这种残留多半是「先手删了 `.hermes-purge` 目录」造成的 —— 删掉这两个文件即可，它们就在 site-packages 里
- `audit.jsonl` 里 apply / revert 条数能对上，说明操作序列完整；只有 apply 没有 revert = 没撤过

### 只撤 1.x 那套

```bash
node bin/hermes-purge.js --revert --target="$T"     # 按 .bak 逐个还原
node bin/hermes-purge.js --uninstall --target="$T"  # 再加一步：删 .hermes-purge/state.json
```

### 只撤 v2 那套

```bash
node bin/purge.js revert --target="$T"
node bin/purge.js revert --id=<快照 id> --target="$T"    # 逐级回退
```

### 两套都撤完后还要一件事

**重启 Hermes。** 已 import 的模块、已冻结的 `_YOLO_MODE_FROZEN`、shim 装过的属性都不会因为磁盘文件变了就复原。

---

## 7. 3.1.x 的新故障（这几个只有真机会遇到）

3.1.x 在真实宿主上又踩到五种，逐条给判据。**每条都先给「怎么确认」，再给「怎么修」**。

### 7.1 `apply` 报成功，`status` 却说 `drifted`（sentinel 不匹配）

**判据**（两条命令对比）：

```bash
node bin/purge.js apply  --target="$T" | tail -3      # 改写 N · 未命中 0
node bin/purge.js status --target="$T" | sed -n 2p    # 却有 drifted
grep -c '\[hermes-purge\]' "$T/agent/turn_context.py" # marker 明明在
```

marker 在、`apply` 说改了、`status` 却说不可用 —— 这是**判定串**对不上：文本层默认找
`[hermes-purge] <cap id>`，但有些替换的注释里没写 cap id。

**怎么确认是哪条**：

```bash
node bin/purge.js status --json --target="$T" \
  | grep -A3 '"status": "drifted"' | grep '"id"'
```

**修**：3.1.6 起这些 cap 都带了显式 `sentinel`（`lib/patches.js` 里的 `SENTINELS`），
先确认版本 ≥ 3.1.6；自己加新锚点时，注释里**务必带上 cap id**（`# [hermes-purge] C13 …`）
或显式给 `sentinel`。回归测试：`node test/sentinel.js`。

### 7.2 `config.yaml` 的 `approvals.mode` 没改成 `off` / 注释越叠越多

**判据**：

```bash
grep -A3 '^approvals:' "$T/../config.yaml"
```

三种病态输出，一眼可辨：

```yaml
mode: prompt                              # 病 1：值没改，G01 永远 pending
timeout: 86400  # [hermes-purge]  # [hermes-purge]   # 病 2：每 apply 一次多叠一层
# （没有 model: 段）                        # 病 3：C15 永远 pending（无处可写）
```

**修**：

- 病 1 / 病 2 → 3.1.6 起 `yamlApprovals` 按块重写（`mode: 'off'` / `timeout: 86400` 都走「有则替换、无则插入」，marker 每行最多一个）
- 病 3 → 3.1.7 起 `yamlMaxTokens` 在根上没有 `model:` 段时会补出一段
- 改完重跑 `purge apply`；幂等回归：`node test/conf-yaml.js`

### 7.3 `.env` 里有 `HERMES_APPROVAL_MODE=prompt`，`apply` 之后还是 `prompt`

**判据**：

```bash
grep -E '^HERMES_(YOLO_MODE|APPROVAL_MODE)=' "$T/../.env"
```

**原因**：3.1.6 之前 `appendEnv` 只判断「键在不在」，值错了也算已生效。

**修**：3.1.7 起值感知 —— 值不对**就地改写**那一行，缺的键才追加；`.env` 不存在会自动创建。
回归：`node test/conf-yaml.js`（值改写 / 缺文件创建 / 幂等）。

### 7.4 macOS 上 `purge agent install` 之后服务起不来、日志一片空白

**判据**：

```bash
purge agent status                                   # pid=（未运行）
launchctl print gui/$(id -u)/com.xiaobingan.hermes-purge.serve | grep -E 'state|last exit'
ls -l ~/Library/Logs/hermes-purge-serve.log          # 0 字节
ps -o pid,etime,command -p <pid>                     # 进程在，但端口不通
```

如果 `ps` 里进程活着、`lsof -iTCP:9123` 空、日志 0 字节 —— `sample <pid> 1 -f /tmp/s.log`，
栈里若出现 `BindingData::… → ReadFileSync → open`，就是**卡在 TCC 授权**：
launchd 代理访问 `~/Documents` `~/Desktop` `~/Downloads` 会挂住。

**修**：当前 `lane/mac` 起（v3.1.8 及以后） `agent install` 会把运行时复制到 `~/.hermes-purge/app` 再让 plist 指向它
（不受保护的位置）。手动版：

```bash
purge agent uninstall
HERMES_PURGE_HOME=~/.hermes-purge purge agent install --target="$T"
```

另一个常见现象：`launchctl print` 显示 `state = not running`、`last exit code = (never exited)`
—— 那是只 `bootstrap` 没 `enable`，label 停在 disabled。当前 `lane/mac` 起（v3.1.8 及以后）安装流程是
`bootout → enable → bootstrap → kickstart`，并会探测 `/api/health` 报「已就绪」。

### 7.5 `status` 慢（几秒才出结果）

**判据**：

```bash
time node bin/purge.js status --target="$T" > /dev/null
find "$T" -name '*.py' -not -path '*/venv/*' | wc -l     # 文件越多越慢
```

**原因**：3.1.8 之前每个符号都要把全树 `.py` 读一遍，且每个 AST 符号起一个 python 进程。

**修**：当前 `lane/mac` 起（v3.1.8 及以后）符号索引 + `_ast.py locate-batch`。本机（4937 个 `.py`）实测 **2.4s → 0.4s**。
若你的树特别大且符号落在 `agent/ tools/ hermes_cli/ acp_adapter/` 之外，索引会自动退回全树扫描
（结果不变，只是这一次慢一点）。回归：`node test/ast-batch.js`。

---

## 速查表

| 症状 | 第一条命令 |
|---|---|
| 不知道哪条 cap 没落 | `node bin/purge.js status --json --target="$T"` |
| 落了但运行时不对 | `node bin/purge.js verify --level=2 --target="$T"` |
| 怀疑文件被改过 | `node bin/purge.js doctor --target="$T"` |
| 想看每层能不能落 | `node bin/purge.js status --impl=shim --target="$T"` |
| 配置层 5 条集体 drifted | `ls "$T/../config.yaml"` |
| `hp` 报 EHP_CONFIG | `node bin/hp.js --home="$HOME/.hermes" "..."` |
| 回滚有没有退干净 | `cd "$T" && git status --short \| grep -v '\.bak'` |
| 文件是不是被写坏 | `grep -c $'\r\r' "$T/tools/approval.py"` |
| apply 说改了但 status 说 drifted | `node test/sentinel.js`（判定串自洽性） |
| config 的 mode 改不动 / 注释越叠越多 | `grep -A3 '^approvals:' "$T/../config.yaml"` |
| `.env` 值没改 | `grep -E '^HERMES_(YOLO_MODE\|APPROVAL_MODE)=' "$T/../.env"` |
| macOS 服务起不来、日志空 | `purge agent status` + `launchctl print gui/$(id -u)/com.xiaobingan.hermes-purge.serve` |
| status 慢 | `time node bin/purge.js status --target="$T"` |

跑完还不知道问题在哪，就把这三份输出一起留档：`purge status --json`、
`purge verify --level=2`、`cat "$T/.hermes-purge/v2/audit.jsonl"`。