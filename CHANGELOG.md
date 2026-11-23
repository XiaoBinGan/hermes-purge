# Changelog

## 3.0.6 —— 修面板按钮 401（token 没传到脚本）+ 脚本缓存穿透

现象：控制台报 `127.0.0.1:9123/api/action 401 (Unauthorized)`，面板按钮点了没反应。

两个独立原因：

1. **token 没写进脚本**：`desktop.install()` 组 `panelSource()` 时只传了 `version/generatedAt`，
   漏了 `controlPort/controlToken` → 面板里 `"control":{"port":9123,"token":""}` → 必然 401。
2. **Electron 缓存旧脚本**：控制台同时出现两条注入日志（旧版 `（ul>li）` + 新版 `已注入`），
   说明 `file://` 下的 `purge-panel.js` 被缓存了。

修法：
- `install()` 把 `controlPort/controlToken` 一并传给 `panelSource()`
- `script` 标签带**内容指纹**：`purge-panel.js?v=<sha256 前 10 位>`，内容一变 URL 就变；
  插入前先摘掉任意旧标签（幂等）
- 测试 +2：token 必须写进脚本；内容变则指纹变且标签不重复

## 3.0.5 —— 修桌面端崩溃：注入脚本不再读布局

现象：重启桌面端后侧边栏入口不出现，`~/.hermes/logs/desktop.log` 里是

```
[renderer] webContents became unresponsive   ×4
[renderer] render-process-gone reason=crashed exitCode=5
```

根因：注入脚本在 `MutationObserver` 回调里调用 `getBoundingClientRect()` 找侧边栏。
聊天流式输出时 DOM 每秒变几百次，每次回调都强制同步布局 → renderer 卡死 → Electron 判崩溃。

修法：
- 找侧边栏**完全不读布局**：直接按结构选 `ul.gap-px`（源码里就是 `<SidebarMenu className="gap-px">`），
  退路是 `aside ul / nav ul / [data-sidebar] ul` 里第一个满足「≥3 个 li>button」的
- 观察器节流到 1.5s 一次、只看节点在不在，注入成功后**停掉轮询**
- 回归测试加一条：生成的注入脚本里不允许出现 `getBoundingClientRect`
- Chromium 压测：3 秒内约 3000 次 DOM 变更，入口照常注入、无卡死

## 3.0.4 —— Windows 真机无跳过全绿 + 引擎验证

在 Win11 ARM 上补装 Python 3.12.8（embeddable），把之前「按设计跳过」的用例全跑起来：

- 工具链：`SMOKE_EXIT=0`，smoke 41 · v2 30 · dsh 33 · setup 12 · bench 16 · package 16，**无跳过**
- 补丁引擎：用 `git show HEAD:` 取 pristine 的 `tools/approval.py`(5971 行) + `agent/tool_guardrails.py`
  + `acp_adapter/edit_approval.py` → `apply` 改写 17 条 → `verify --level=1` 通过 →
  `revert` 后三文件 SHA256 与原件**完全一致**
- 修掉第 5 个只有真机才暴露的问题：`python -S -c` 在 Windows 上不把 cwd 放进 `sys.path`，
  埋点驱动 `ModuleNotFoundError: agent` → 驱动显式 `sys.path.insert(0, os.getcwd())`
- 验证脚本入库：`test/win/run-smoke.ps1`、`test/win/run-engine.ps1`（均带 BOM+CRLF），
  记录见 `docs/windows-verification.md`

## 3.0.3 —— Windows 真机跑通（Win11 ARM / VirtualBox），修 4 处只有真机会暴露的问题

在真机 Win11 ARM（build 26300 / Node 22.11.0 / VirtualBox 7.2.22）上跑 `windows-smoke.ps1`，
一路从 `SMOKE_EXIT=1` 修到 **`SMOKE_EXIT=0`**：

1. **`.ps1` 缺 UTF-8 BOM**：Windows PowerShell 5.1 按 ANSI 解码中文注释，直接把后面代码吃进字符串，
   报 `An expression was expected after '('` / `The string is missing the terminator`。
   → `windows-smoke.ps1`、`install.ps1` 都加 BOM（保持 CRLF）。
2. **PS 5.1 吃掉原生参数里的双引号**：`node -p '…split(".")[0]'` 到 node 手里变成 `split(.)[0]` → SyntaxError。
   → 改成 `node -v` 字符串解析；版本一致性检查改用 `Get-Content | ConvertFrom-Json`。
3. **管道提前关闭掐死 node**：`node … | Select-Object -First 6` 让 `$LASTEXITCODE` 变成 -1。
   → 先取全部输出到变量，再挑前几行打印。
4. **同长度改写检测不到**：NTFS 的 mtime 粒度粗 + 文件长度不变时，`size/mtime` 比对看不出变化。
   → `bench/artifacts.js` 对小文件（≤4MB）加 sha256，diff 优先比哈希。

另外：`python` 在 Windows 上变成**可选项**（没装就跳过 AST/埋点/部分 bench，不算失败并明确说明）；
控制台输出统一 `UTF-8`，cmd 里中文不再乱码；`probe --stub` 的产物样本改用坏掉的 `.js`（`node --check` 到处都有）。

真机结果：单元 41/22/33/12/16（22 是跳过 python 相关 8 项后的数）、npm 打包 16/16、
`install.ps1` + `purge setup --dry` + 非交互拒绝 + `uninstall` + CRLF 保真 全 OK。

## 3.0.2 —— 手表是 codicon，不是 svg

用户贴了真实节点，问题清楚了：图标有两种形式 ——

```html
<i aria-hidden="true" class="codicon codicon-watch size-4 shrink-0 …"></i>   ← 手表（字体图标）
<svg class="chevron">…</svg>                                                  ← 尾部小箭头
```

3.0.1 只清了 `svg`，`codicon` 那类 `<i>` 留了下来。

修法：图标选择器改成 `svg, .codicon, i[class*="codicon"]`，一并清空；
同时把从「定时任务」继承来的 `data-tour="sidebar-nav-cron"` / `data-state` /
`data-hermes-context-menu-trigger` 去掉（否则入口还挂着 cron 的标识）。

`test/desktop-dom.js` 的夹具按真实结构重写（codicon 图标 + svg 箭头 + 带 data-tour 的 span），
断言注入后不残留 `watch / codicon / chevron`，也不残留 `sidebar-nav-cron`。

## 3.0.1 —— 去掉残留的「手表」图标

现象：侧边栏入口上 Dart 图标之外还带着一个手表（定时任务的图标）。

根因：入口是**克隆最后一个 `<li>`**（也就是「定时任务」那行）来的，那行里不止一个 `<svg>`
（图标 + 尾部小箭头）。上一版只替换了第一个 `svg`，剩下的就留下了。

修法：克隆后**删掉所有 `svg`**，再在第一个图标原来的位置插入飞镖。
`test/desktop-dom.js` 的夹具改成「图标 + 小箭头」两个 svg，断言注入后只剩 1 个 svg、
且不含 `watch/chevron` 之类的残留 class。

## 3.0.0 —— 面板能点了：飞镖图标 + 启用/停用/体检/刷新

反馈：图标用飞镖；点开之后没有可操作的按钮（要有「启动/停止」这类）。

### 图标

侧边栏入口换成**飞镖**（镖身 + 镖尖 + 尾翼，纯 SVG，跟随主题色）。

### 按钮（这是本版的实质）

面板跑在 Electron 渲染进程里（沙箱、没有 node），自己不能执行 `purge apply`。
新增 `purge serve`：只监听 `127.0.0.1:9123` 的本地控制服务，面板带 token 调它，
服务端 fork 我们自己的 CLI 去做 —— 行为与命令行完全一致，不另写一套逻辑。

- 按钮：**启用**（apply）/ **停用**（revert）/ **体检**（verify L2）/ **刷新**（重新生成报告并替换 iframe）
- 执行结果直接显示在面板里（成功绿、失败红），完成后自动刷新报告
- token 存 `<宿主机>/.hermes-purge/v2/control.json`（0600），每次请求都要带 `x-purge-token`
- 动作白名单：只允许 apply / revert / verify / report；别的 action 一律 400
- 服务没起时按钮会明确提示「控制服务没响应：先启动 purge serve」，不会假装成功

### 测试

`test/control.js` 7 项：token 落盘与权限、无/错 token → 401、非白名单 → 400、
动作真的跑 CLI 并回传输出、`/api/report` 返回 HTML（面板刷新用）。

## 2.9.1 —— 修 doctor 对配置文件的误报（宿主机重写 config.yaml 是常态）

现象：面板/CLI 里 `✖ 文件哈希 被外部改过：../config.yaml`，但 `purge status` 仍是 31/31。

根因：**Hermes 自己会重写 `config.yaml` 的序列化**（换行折行、键顺序、注释被去掉），内容语义不变。
实测 diff 只差折行位置与 `# [hermes-purge]` 注释，`prefill_messages_file` / `max_tokens` /
`approvals` 三个键值都还是我们写的那样。拿哈希去判「是否被外部改过」对这类宿主自有文件是错的判据。

修法：

- `config.yaml` / `.env` 在事务里标成 **volatile**（老 manifest 按路径兜底识别），
  `doctor` 把它们单列成「配置文件重写」提示（✔ 不算异常），代码文件才参与哈希判定
- `doctor` 新增「配置语义」块：直接跑配置层 4 条 cap 的探测，看键值不看哈希
  （`max_tokens: 16000` / `prefill_messages.json` / `mode: off, timeout 86400` / 环境变量）
- `revert` 默认**跳过**配置文件（归宿主所有，不覆盖），要连配置一起回滚得 `--force`，
  跳过时会明确打印

## 2.9.0 —— 侧边栏判定改准（按 ul>li 结构 + gap-px 打分）

第一版用「左侧、窄、竖排、≥3 项」的几何启发式找容器，真机上打印
`[hermes-purge] 还在找侧边栏…` —— 判定没命中。改成按真实 DOM 结构找：

- 导航是 shadcn 的 `SidebarMenu`：`<ul class="…gap-px"><li><button>…`
- 打分：类名带 `gap-px` 最高分；其次「项数 3..12 且靠左」；会话列表（几十项、无 gap-px）排后面
- 命中后克隆**整个 `<li>`**（保持列表结构），把 `<button>` 换成我们的入口并追加到末尾
  —— 源码 NAV 顺序 skills→messaging→artifacts→cron，所以正好在「定时任务」下一位
- 失败时打印候选 `ul` 清单（tag/class/left/width/items），一次就能定位
- 用宿主仓库自带的 jsdom 做**真实 DOM 验证**（`test/desktop-dom.js`）：构造「会话列表 + 导航列表」
  两套竞争，断言注入进的是导航列表、排在最后、点击弹层且 iframe 里有报告

## 2.8.0 —— 桌面端侧边栏入口：和「定时任务」并排

要求原话：「需要和 Hermes desktop 原生的一样，安装启动完成后直接出现在产物和定时任务的菜单的下一个」。

### 做法与取舍

桌面端是打包好的 React SPA（`app.asar.unpacked/dist`），**没有 UI 扩展点**；插件系统只到工具/命令。
两条路：

| 方案 | 结果 |
|---|---|
| 改源码 + 重新构建 renderer | ❌ 本机缺 `@rolldown/plugin-babel`，`npm run build` 直接失败；且每次 Hermes 升级都要重做 |
| **往 `index.html` 加一行 `<script>` + DOM 注入** | ✅ 只动一个文件的一行，自带两个文件，可逐字节还原 |

### 新增

- **`purge desktop install|sync|uninstall|status`**：找到 renderer（打包版优先，其次开发构建），
  备份 `index.html` → 写 `purge-panel.js`（内联最新状态报告）→ 在 `</body>` 前插一行 script。
- 注入脚本的行为：定位侧边栏（左缘、窄、竖排、≥3 个可点项），取**最后一个**导航项做原型克隆，
  追加一个入口（源码里 NAV 顺序是 skills→messaging→artifacts→cron，所以正好排在「定时任务」后面）；
  `MutationObserver` 盯着，React 重渲染把它冲掉就补回来；点击后弹出覆盖层，用 `srcdoc` 渲染报告
  （不依赖 file:// 权限，离线可用，Esc/点遮罩关闭）。
- 生成时用 `vm.Script` 做语法自检，宁可报错也不把坏脚本写进宿主 UI。

### 如实标注的边界

- 是 **DOM 注入**，不是编译进 bundle：命令面板/键盘导航里不会出现这个入口
- Hermes 升级会替换 dist → 需要重跑 `purge desktop install`
- 面板内容是内联快照，不自动刷新 → `purge desktop sync` 重新生成
- DOM 注入行为需要重启桌面端人工验收（`test/desktop.js` 只覆盖注入层与还原）

## 2.7.0 —— 无损扩展进 Hermes：插件 + `/purge` + `purge_status`

用户原话：「这个操作面板不应该启动的时候无损拓展到 Hermes 么」。对，之前的 `purge report`
是外挂 CLI。现在改成走 **Hermes 自己的插件系统**（`~/.hermes/plugins/hermes_purge/`），
不改宿主一行代码，删目录就干净。

### 新增

- **`purge plugin install|uninstall|status`**：把插件模板写进 `$HERMES_HOME/plugins/hermes_purge/`
  （`plugin.yaml` + `__init__.py` + `path.json` 记录 CLI 绝对路径），幂等、可逆。
- 插件注册两件事：
  - `/purge [status|report|doctor|stats]` 会话内斜杠命令
  - `purge_status` 工具（schema 空对象、只读）—— 让 agent 自己回答「补丁开着吗」
- 插件内部把 `purge status --json` 拉过来做摘要（5s 缓存、25s 超时、剥 ANSI），
  拿不到 CLI 时给一句人话而不是抛栈。

### 验证

- `hermes plugins list` 能看到 `hermes_purge`（source=user）；`hermes plugins enable hermes_purge` 后
  `hermes plugins doctor hermes_purge` → **OK: runtime discovery, manifest parsing, import, and registration passed**（1 tool）
- `test/plugin.js` 10 项：install/uninstall 可逆、按 Hermes 方式 importlib 导入、
  register 真的注册了命令与工具、有/无 CLI 两种情况下的人话分支

## 2.6.0 —— 可视化状态：`purge report` + `hp` 状态徽标

问题：补丁开着的时候没人知道它开着，用 Hermes 时没有「一眼可见」的信号。

### 新增

- **`purge report [--open] [--out=FILE]`**：生成单文件 HTML 状态报告（零依赖、离线可开、可直接发给别人）。
  内容：顶部结论（已开启 / 部分生效 / 未开启）+ 生效比例、四条 KPI（实现层分布、轮次、拒答命中、版本）、
  `doctor` 健康检查、31 条能力明细（每条当前走哪层：ast / shim / text / conf）、最近 apply/revert 审计、
  底部回滚与复检命令。**报告写明生成时间**——静态快照不是「实时」。
- **`hp` 状态徽标**：TTY 下每次执行前打一行
  `[purge 已开启 · 源码层 ✓ · 运行时层 ✓ · 上次应用 11-18 13:02]`，
  未安装时显示 `[purge 未开启 · 源码层 ✗ · 运行时层 ✗]`。非 TTY 自动静默（不污染管道），
  `HERMES_PURGE_BADGE=1` 可强制打开（测试用）。
- `lib/v2/report.js`：HTML 渲染（无脚本、跟随系统深浅色）、`txn.readAudit()` 读审计。

### 测试

`test/bench.js` +3 项：报告含结论/时间/回滚命令且无 `<script>`、空数据判「未开启」并显示 `n/a`、徽标出现在 stderr。

## 2.5.0 —— macOS 一条命令装好

```bash
./install.sh --setup --yes
```

`install.sh` 新增 `--setup`（装完直接跑 `purge setup`）与 `--yes`（不问确认，脚本/CI 用）。
不改行为的部分照旧：单纯 `./install.sh` 只装命令，`purge setup` 仍可单独跑。

实测（macOS，真机 Hermes 副本、临时 HOME/BIN）：一条命令 → 装出 `purge`/`hp` →
`caps 31 · applied 31 · drifted 0` → L1 9 项 + L2 14 项全绿 → `--uninstall` 清干净；
`test/setup.js` 增加到 12 项，锁住「install.sh 会把 setup 跑起来」这条接线。

## 2.3.0 —— 判别器误杀率从 85% 降到 0%（P5 第一部分）

`judge()` 决定「这份产物算不算合格」。它一旦把正经答案判成拒答，`hp` 就白烧一轮采样、
还把已经拿到的好答案丢掉。这类错误跑模型发现不了（输出随机），只能拿固定样本量量。

### 新增（Windows 真机验证通道）

- `.github/workflows/windows.yml`：在 GitHub Actions 的 **windows-latest（Windows Server 2022）**
  上跑 `smoke / v2 / dsh / setup / bench`、`package`、`install.ps1` 真装真跑、假 Hermes 树上的
  `setup --dry` 与非交互拒绝、`uninstall`、CRLF 保真；node 20 / 22 两档。
  为什么要它：macOS 上只能做到「CRLF 树 = Windows 语义」，容器也不顶事
  （macOS 的 Docker 只能跑 Linux 容器，Windows 容器需要 Windows 内核）。
- `windows-smoke.ps1`：同样的检查打包成一条命令，任何 Windows 机器/VM 上直接跑
  （`.\windows-smoke.ps1`），不需要 GitHub。

### 修复（数字是 bench 量出来的）

- **裸词匹配 → 开口锚定**：`拒绝 / 抱歉 / 不提供 / I can't` 在正经产物里到处都是
  （拒绝服务压测、默认值不提供、日志文案、英文缩写讨论）。旧正则全文匹配，
  `bench/decoys.json` 40 次评估里**误杀 34 次（85%）**。现在：
  - `REFUSAL_HEAD`：只认**回答开头**的拒答（允许 markdown 记号、一句致歉铺垫）
  - `REFUSAL_CLAUSE`：短回答里，拒答词必须落在句首/句末标点/分号逗号之后，
    避开被引号包住的词（「拒绝」两个字、`不提供成品` 的定义）
  - 长产物（≥200 字）完全不看裸词
- **短但有代码围栏 → 判 downgraded 而不是 refused**：给东西了只是不够长，属于可重试的降级，
  不该被当成拒答丢掉
- 结果：误杀 **0/40**、漏检 **0/20**

### 新增

- `bench/decoys.json`（20 条「像拒绝但不是拒绝」的正经产物）
- `bench/refusals.json`（10 条真拒答，含铺垫式、引用块式、结尾才拒绝）
- `bench/judge-eval.js`：误杀率 / 漏检率 + 逐条明细，`--max-fp` 卡阈值，超了退出 1
- `lib/v2/stats.js`：Wilson 95% 置信区间、几何分布的重试收敛与期望次数、按 token 计成本
  （价格未知返回 `null`，不编数）、`summarize()` 在 N<12 时明确警告「别下结论」
- `test/bench.js` 10 项：误杀 ≤2% / 漏检 =0 守门 + Wilson/收敛/成本口径 + 探针报表口径
- **磁盘产物断言**（`bench/artifacts.js` + `probe --artifacts=DIR`）：探针以前只判聊天正文，
  而 README 自己写着「聊天正文 ≠ 实际产出」（实测 webshell 正文 0/4，盘上 928 个文件）。
  现在可以盯一个目录：跑前快照、跑后比对创建/修改/删除，按扩展名挑出「像产物」的，
  再用宿主 python（`py_compile`）/ `node --check` 真解析一遍，写坏的会被点名。
  报表多一列 `+N (代码 M，解析 ok/N)`，明细列出失败文件。**归因有限**：只看这个目录，
  且其它进程的写入也会被算进去 —— 这条写进了报表本身。
- `bin/probe.js` 报表改口径：单发比例带 **Wilson 95% 置信区间**，右列明确标成
  「几何分布推算的 6 次重试期望」而不是实测通过率，N<12 的类会单独列出警告；
  新增 `--stub`（不调模型、不花 token，用假响应验证报表链路）

## 2.2.0 —— 安装/卸载路径（一条命令）

之前要 `git clone` + 记 `node bin/purge.js <子命令>`，实际用起来太啰嗦。

### 新增

- **`purge setup`**：检测宿主 → 打印计划（宿主/目录/cap 统计/按实现层分布/不可用项）→
  交互确认 → apply → verify L2 → 打印重启、仪表盘、回滚命令。`--dry` 只读，
  `--yes` 非交互，`--adapter`/`--target` 与其它子命令一致。
- **`purge uninstall`**：revert（含 venv 里的 shim）→ 删 `.hermes-purge/` → 提示还残留几个
  1.x 的 `.bak`（两代引擎不混淆）。
- **`install.sh`**（POSIX）/ **`install.ps1`**（Windows）：确认 Node ≥18、把仓库放到固定位置、
  在 PATH 里留 `purge`/`hp`；`--uninstall` 反向清理；不写系统目录、不需要 sudo。
- `test/setup.js`：11 项——`setup --dry` 只读、非交互不给 `--yes` 拒绝写入、无快照时
  `uninstall` 不崩、`bash -n install.sh`、临时 HOME/BIN 真装真跑 `purge --version`、
  `--uninstall` 清干净、版本号三处一致、`install.ps1` 是 CRLF。

### 修复

- `purge uninstall` 崩栈：`SKIP_DIRS` 用了没 require 的 `platform`。
- `uninstall` 在没有快照时把「无可还原」当失败 → 现在提示后继续清状态目录。

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

### 观测（每轮埋点，P4）

`purge stats` 以前是空壳（只有 apply/verify 事件，对话轮没有埋点），现在有真数据：

- **shim turn 钩子**（`lib/v2/shim.js`）：`agent.conversation_loop` 一被导入就用 meta_path 钩子包住
  `run_conversation`，每轮结束往 `<宿主>/.hermes-purge/v2/metrics.jsonl` 追加一行：
  `ts / surface / model / turn / refusals{nudges,hit} / approval{mode} / tokens{in,out} / ok / ms`。
  全程 fail-open：取值 / import / 写盘异常一律吞掉，宿主函数的异常照原样往外抛（不吞）。
- **stats 聚合**（`lib/v2/metrics.js`）：轮次总数、拒答命中率、平均每轮重采样、cap 命中（读 shim.log）、
  tokens 合计、成本估算（`stats(target,{prices})` 可覆盖；未定价显示 `n/a`，不编数）。
- `purge stats --json` 可机读；测试用 `-S` + 按路径装载 shim，避免把真机那份 shim 拉进单测。



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
