# Windows 泳道作业单（照做即可）

给你的机器上那份 clone 用。目标：把 **C13 / C14 / C16** 三条补上锚点，让 `purge status` 到 **31/31**。

> 前提：`main` / `lane/mac` 已有全部基础设施（符号索引、批量 AST、sentinel 校验、parity 对账）。
> 你要改的**只有一个文件**：`lib/anchors/hermes-win.js`（mac 泳道永远不碰它）。

---

## 0. 先对齐代码

```bash
cd /g/hermes/hermes-purge

git fetch origin
git checkout lane/win
git merge origin/lane/win            # 拿队友已推的东西（若有）
git merge origin/lane/mac            # 拿 mac 侧基础设施；两者改的文件不重叠，不会冲突
node bin/purge.js status --target=G:/hermes/hermes-agent | sed -n 2p
```

期望看到（数字可能不同，关键看 `drifted`）：

```
python=…  ·  caps 31  ·  applied 28  pending 0  drifted 3
```

确认是哪三条、以及每条的失败层次：

```bash
node bin/purge.js status --json --target=G:/hermes/hermes-agent \
  | grep -B2 -A4 '"status": "drifted"'
```

`"tried": ["text:missing", "variant:missing"]` = 主锚没命中、变体也没命中 → 需要你补锚点。

---

## 1. 在宿主里找到真实落点

三条要改的是同一件事在宿主不同位置的副本。**先找，不要猜缩进**：

```bash
cd /g/hermes/hermes-agent

# C13 / C14：系统提示词以 system 角色注入的那一行
grep -rn 'content": effective_system' --include='*.py' agent/ | head

# C16：prefill 注入循环
grep -rn 'prefill_messages' --include='*.py' agent/ | head
grep -rn 'sys_offset' --include='*.py' agent/ | head
```

找到后**逐字看清缩进**（Git Bash 有 `cat -A`，行尾 `$` 前的内容就是原文）：

```bash
sed -n '起始行,结束行p' agent/<文件>.py | cat -A
```

记下三样：**文件路径**、**起始行号**、**每行前面的空格数**。

---

## 2. 检查 C16 需要的助手函数

```bash
grep -rn '_clone_message_for_send' --include='*.py' /g/hermes/hermes-agent/agent/ | head -3
```

- 有 → 直接用（下面模板里就是它）
- 没有 → 把模板里 `_cl = _clone_message_for_send(pfm)` 换成 `_cl = dict(pfm)`，
  并在提交说明里写清楚用了哪种写法

---

## 3. 写进 `lib/anchors/hermes-win.js`

文件现在长这样：

```js
module.exports = { label: 'win-lane', map: {} };
```

改成（`<...>` 全部换成你第 1、2 步查到的东西）：

```js
const label = '0.21.x-win';          // 换成宿主真实版本号；不确定就写 'win-lane'
module.exports = { label, map: {
  C13: [{ file: 'agent/<文件>.py', kind: 'splice',
    find: `<逐字复制那几行，含缩进，末尾带 \n>`,
    to: `# [hermes-purge] C13 改为 in-history user 注入
<同样缩进>api_messages = [{"role": "user", "content": effective_system}, {"role": "assistant", "content": "ok"}] + api_messages
` }],

  C14: [{ file: 'agent/<文件>.py', kind: 'splice',
    find: `<同上>`,
    to: `# [hermes-purge] C14 摘要路径同步搬移
<同样缩进>api_messages = [{"role": "user", "content": effective_system}, {"role": "assistant", "content": "ok"}] + api_messages
` }],

  C16: [{ file: 'agent/<文件>.py', kind: 'splice',
    find: `<prefill 那几行原文，含缩进>`,
    to: `<把 prefill 改成追加到消息末尾的版本，缩进按这台机器调；参考 lib/anchors/hermes-0.21.0.js 里的 C16>` }],
} };
```

三条铁律（违反会出真问题，不是风格问题）：

1. **`find` 必须带真实缩进**。缩进错了会「匹配成功但写坏代码」→ 宿主 `IndentationError`，
   比匹配不上更糟（历史事故：C14 在某个版本是 12 空格、主锚是 8 空格）
2. **`to` 的注释里带 cap id**（`# [hermes-purge] C13 …`）。文本层默认拿
   `[hermes-purge] <cap id>` 当 sentinel；不带 id 会「改成功却报 drifted」
3. **不确定先干跑**：`node bin/purge.js apply --dry --target=G:/hermes/hermes-agent`

---

## 4. 验收（全过才算完成）

```bash
cd /g/hermes/hermes-purge

# ① 探测：三条必须从 drifted 变 pending
node bin/purge.js status --target=G:/hermes/hermes-agent | sed -n 2p

# ② 应用
node bin/purge.js apply --target=G:/hermes/hermes-agent

# ③ 再看：必须 31/31
node bin/purge.js status --target=G:/hermes/hermes-agent | sed -n 2p
#   期望：applied 31  pending 0  drifted 0

# ④ 静态 + 运行时
node bin/purge.js verify --level=1 --target=G:/hermes/hermes-agent
node bin/purge.js verify --level=2 --target=G:/hermes/hermes-agent
node bin/purge.js doctor  --target=G:/hermes/hermes-agent

# ⑤ 行尾没被破坏（Windows 上是 CRLF，改完还得是 CRLF）
file agent/<被改的文件>.py

# ⑥ 回滚逐字节还原
node bin/purge.js revert --target=G:/hermes/hermes-agent
git -C G:/hermes/hermes-agent status --porcelain      # 应为空
node bin/purge.js apply  --target=G:/hermes/hermes-agent   # 再装回去

# ⑦ 自测（这几条都在 npm test 里）
node test/sentinel.js      # 判定串自洽
node test/parity.js        # 指纹结构
```

---

## 5. 和 mac 对账（这一步才算真的「两边一样」）

```bash
# Windows 侧导出效果指纹
purge parity --out=win.json
```

把 `win.json` 发给 mac 侧，或者自己跟 mac 的比：

```bash
purge parity --diff=mac.json
# 一致 → 退出码 0：「两边效果一致：31 条 cap 的 status 与实现层完全相同」
# 不一致 → 退出码 1，并先给按层结论：
#   按层对比
#     ✖ code    本机 25/25 · 对端 22/25  缺/异: C13 C14 C16
```

---

## 6. 提交

```bash
git add lib/anchors/hermes-win.js
git commit -m "fix(anchors): 支持 Hermes <版本> 的 C13/C14/C16（<文件> 布局）"
git push origin lane/win
```

合并前跑一次护栏（四项应全 ✔，其中「没碰对方锚点文件」这一项会检查你有没有动
`lib/anchors/hermes-0.21.0.js`）：

```bash
scripts/lane-guard.sh --lane=lane/win
```

---

## 报告格式（把这几行贴回来）

```
宿主版本：<x.y.z>
C13 落点：agent/<file>.py:<行号>，缩进 <n> 空格
C14 落点：agent/<file>.py:<行号>，缩进 <n> 空格
C16 落点：agent/<file>.py:<行号>，缩进 <n> 空格；_clone_message_for_send 存在=<是/否>
补丁前：applied 28 / drifted 3
补丁后：applied 31 / drifted 0
verify：L1 <n> 项 / L2 <n> 项 <通过|失败>
revert：git status <干净|有残留>
parity：purge parity --out=win.json 已导出
```

## 遇到这三种现象，先看 troubleshooting 第 7 节

| 现象 | 章节 |
|---|---|
| apply 说改了，status 说 drifted | 7.1（sentinel 不匹配） |
| `approvals.mode` 改不动 / 注释越叠越多 | 7.2 |
| `.env` 里值错却没报错 | 7.3 |
