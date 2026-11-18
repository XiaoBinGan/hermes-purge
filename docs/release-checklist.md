# 发版检查单

结论先行：**下面任何一条不过，就不发。** 不写「基本可用」，不把未实测写成已实测，不拿推论代替运行。

本单里的数字都是 2026-11-18 在 macOS + Hermes 0.21.0 上真跑出来的，可以直接对照。

---

## 0. 环境（1 分钟）

```bash
node -v                       # 必须 >= 18（package.json 的 engines）
git status --short            # 必须只有本次要提交的文件
git branch --show-current     # 确认在预期分支
```

判读：`git status` 里出现 `lib/`、`bin/`、`test/`、`package.json` 的改动 —— 除非这次就是要改它们，否则先查清楚是谁动的。

---

## 1. 静态自检（必须全绿）

```bash
node test/smoke.js     # 期望末行：全部通过 41/41
node test/v2.js        # 期望末行：全部通过 22/22
```

判读：出现任何一个 `✖` 就不发。这两个不联网、不改文件、不需要真 Hermes，所以没有「环境不好」这个借口。

`--e2e` 是另一条，而且**必须带目录参数**：

```bash
node test/v2.js --e2e /tmp/hermes-e2e     # 期望末行：全部通过 26/26（22 + 4）
```

```bash
node test/v2.js --e2e                     # 期望：22 通过 · 4 失败 —— 这是参数漏了，不是产品 bug
```

判读：`--e2e` 会真的对那棵树跑 `apply → verify → doctor → revert`。**只能给副本树**，给生产树就是在生产树上做一次 apply/revert。

---

## 2. 树级闭环（副本树上跑，5 分钟）

```bash
T=~/.hermes/hermes-agent
cp -a "$T" /tmp/hermes-e2e                 # 2.3 GB，约 1 分钟
cd /path/to/hermes-purge

node bin/purge.js status --target=/tmp/hermes-e2e
node bin/purge.js apply  --target=/tmp/hermes-e2e
node bin/purge.js verify --level=2 --target=/tmp/hermes-e2e
node bin/purge.js doctor --target=/tmp/hermes-e2e
node bin/purge.js revert --target=/tmp/hermes-e2e
```

要看的三行输出（顺序对应上面三条命令）：

```
改写 25 · 跳过 6 · 未命中 0        ← 未命中必须为 0
L1 静态检查通过
L2 运行时 ✔ 14 项   →   通过      ← 不允许有 ✖ 项
健康                              ← doctor 六项全 ✔
回滚 N 个文件（sha256 已校验）     ← revert 不允许出现「回滚未完成」
```

判读：

- **`未命中` 不为 0** → 有 cap 在这一版宿主上根本落不了。去 `status` 看是哪几条，记进 README 兼容矩阵，别发。
- **`L1 静态检查通过` 但 `L2` 有红项** → 见 `docs/troubleshooting.md` 第 2 节。
- **`cp -a` 之后 `status` 里配置层 5 条（C15/C17/G01/G02/P01）全 `drifted`** → 因为副本少了上一层的配置根。补 `config.yaml`/`.env`/`SOUL.md` 后重跑，别当成回归。

---

## 3. 卸载路径演练（新加的一步，之前没走过）

```bash
node bin/purge.js apply  --target=/tmp/hermes-e2e
node bin/purge.js revert --target=/tmp/hermes-e2e
find /tmp/hermes-e2e -name '*.purge-tmp-*' | head        # 期望：空
cd /tmp/hermes-e2e && git status --short | grep -v '\.bak'  # 期望：只剩未跟踪的 .hermes-purge/
```

判读：

- `git status` 里还挂着被改过的 `.py` → 回滚不干净，不发
- **`doctor` 在 revert 之后报「文件哈希 ✖ / shim 注入 ✖」是正常的**（manifest 记的是 apply 后的样子，shim 是被主动拔掉的）。判干净看上面两条，不看 doctor

手改拒绝覆盖也必须成立：

```bash
node bin/purge.js apply  --target=/tmp/hermes-e2e
echo "x = 1" >> /tmp/hermes-e2e/tools/approval.py
node bin/purge.js revert --target=/tmp/hermes-e2e        # 期望：回滚未完成 + 「以下文件被外部改过」+ exit 1
node bin/purge.js revert --force --target=/tmp/hermes-e2e # 期望：强上，手改被抹掉
```

---

## 4. 文档一致性

```bash
grep -n "未实测" README.md docs/*.md     # 必须有命中：矩阵里得有诚实的不确定
node bin/purge.js | head -25             # 帮助里的子命令/flag
node bin/hp.js                           # 用法段
```

判读：文档里出现的每个 `--flag`，都要能在源码里找到同名解析。当前**确实存在**的 flag：

| 入口 | flag | 出处 |
|---|---|---|
| `purge` | `--target` `--home` `--json` `--dry` `--no-verify` `--level` `--prompt` `--force` `--id` `--since` `--impl` | `bin/purge.js` 的 `parseArgs` + 各 `cmd*` |
| `hp` | `--show` `--raw` `--api` `--dash` `--desktop` `--home` `--tries` `--lang` `--help` | `bin/hp.js` 的 `flags` |
| `hermes-purge` | `--status` `--json` `--apply` `--dry` `--verify` `--revert` `--uninstall` `--target` `--home` | `bin/hermes-purge.js` 的 `args` |

文档里写了上表之外的 flag → 先改文档，别改代码去迁就它。

---

## 5. 版本矩阵抽查

至少挑**一格当前写着「未实测」的**跑一遍（比如 macOS × 0.21.3）：

```bash
cp -a /path/to/hermes-0.21.3 /tmp/hermes-0213
node bin/purge.js status  --target=/tmp/hermes-0213
node bin/purge.js apply   --target=/tmp/hermes-0213
node bin/purge.js verify  --level=2 --target=/tmp/hermes-0213
node bin/purge.js doctor  --target=/tmp/hermes-0213
node bin/purge.js revert  --target=/tmp/hermes-0213
```

判读：

- 全过 → 把 README 兼容矩阵那一格改成「已实测」，并写下判据（哪台机、哪个版本、哪几条命令）
- 有一条不过 → 那一格**保持「未实测」或写清「已实测但 Cxx drifted」**，不许模糊成「基本可用」

---

## 6. 不许发的条件

- `smoke` / `v2` / `v2 --e2e` 任一项有 `✖`
- 副本树上 `apply` 出现 `未命中 > 0`
- `verify --level=2` 有红项，且不能在 `docs/troubleshooting.md` 里对上号
- `revert` 报「回滚未完成」，或回滚后 `git status` 仍有被改的 `.py`
- README / docs 里出现源码中不存在的 flag 或子命令
- 兼容矩阵里出现「已实测」但拿不出命令输出
- `--e2e` 的结果是拿生产树跑出来的（那种「通过」不算数）

---

## 7. 本次已知未验证项（如实列出，别藏着）

1. **DSH 真机**：README 里对 dsh-purge 的对照是取舍记录，本仓库没有在任何真实 DSH 宿主上跑过；`lib/` 与 `bin/` 里也没有 DSH 相关代码路径。
2. **npm 全局安装（干净机器）**：本机只用 `npm i -g --prefix /tmp/hp-prefix .` 验过「装出来的三个 bin 链接 + 能跑 `purge status`」，**没在一台从没装过 Node 全局包的机器上从头验**。`npm i -g hermes-purge`（从 registry 装）依赖包真的发布过，本次也没有验证。
3. **Windows 实机**：0.21.3 / 0.21.4 的闭环是在 CRLF 树（Windows venv 布局）上做的，**没在真的 Windows 上跑过** apply/verify/revert；`purge.cmd` 也没有随仓库提供（只有 `hp.cmd`），Windows 上想用 `purge` 这个短命令得走 npm 或自己放一个 launcher。
4. **Linux**：一次都没跑过。代码里平台分支很少（`lib/v2/platform.js` 的 `isWin`、`lib/core.js` 查 PATH 时的扩展名），但没跑就是没跑。
5. **`test/c18_unit.py` 的路径是写死的**：`sys.path.insert(0, .../../../../../hermes/hermes-agent)`，克隆到别的位置会 `ModuleNotFoundError: No module named 'agent'`。异地跑要么手改这行，要么用 `PYTHONPATH`：
   ```bash
   PYTHONPATH=/path/to/hermes-0.21.3 python3 test/c18_unit.py
   ```
   （这条只在 0.21.3+ 布局的树上成立；本机只有 0.21.0，所以本次未实测。`test/c18_unit_0210.py` 走 `HERMES_ROOT_FOR_TEST`，没有这个问题。）
6. **`test/v2.js --e2e` 不给目录会 4 项失败**：参数陷阱，不是回归；本单第 1 节已经写明。

---

## 8. 发版动作

```bash
git add README.md docs/
git commit -m "docs: 安装与卸载 / 兼容矩阵 / 排查手册 / 发版检查单"
git push        # 只在明确要发的时候
```

- 不 push 就别推；分支名写进 PR 描述
- `CHANGELOG.md` 由发版人单独写，别和文档改动混在一个 commit 里（这条是约定，不是代码约束）
