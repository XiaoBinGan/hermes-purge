# 双端并行规则（macOS 泳道 / Windows 泳道）

两条线各管一台机器，**改不同的文件、用不同的分支**，靠这个结构性隔离来保证不冲突。

## 分支

| 分支 | 谁用 | 说明 |
|---|---|---|
| `lane/mac` | macOS 那条线 | 只在这里提交 mac 侧改动 |
| `lane/win` | Windows 那条线 | 只在这里提交 win 侧改动 |
| `main` | 集成 | 只在两侧都通过各自验收后，由集成方 fast-forward 或 merge 进来 |

规则：
1. **不要在 `main` 上直接提交**（集成除外）。
2. 不要跨泳道推分支，不要 `--force` 推 `main`。
3. 合并顺序不重要，但每次合并前必须：`npm test` 全绿 + 各自实机 `verify --level=2` 通过。

## 文件归属（重点）

| 文件 | 归属 | 说明 |
|---|---|---|
| `lib/anchors/hermes-0.21.0.js` | **仅 mac 泳道** | 0.21.0 替代锚点 |
| `lib/anchors/hermes-win.js` | **仅 win 泳道** | Windows 宿主版本的替代锚点（初始为空 map） |
| `lib/patches.js` | 只读（两侧都不改） | 主锚表 + 装载器；装载器会把上面两个文件并进 variants |
| `package.json` 的 `version` | 仅集成方 | 泳道分支里**不要**改版本号，避免每次发布必冲突 |
| `CHANGELOG.md` | 两侧都写，但**只往自己的小节追加** | 冲突时优先保留两边内容 |
| `test/*` | 各加各的新文件 | 修改既有测试前先在 issue/PR 里说一声 |

`lib/patches.js` 现在是这么装载的（只是读，不用改）：

```js
const LANES = [
  require('./anchors/hermes-0.21.0'),   // mac 泳道维护
  require('./anchors/hermes-win'),      // win 泳道维护
];
for (const lane of LANES) {
  for (const [id, list] of Object.entries(lane.map || {})) {
    const p = PATCHES.find((x) => x.id === id);
    if (!p) continue;
    p.variants = (p.variants || []).concat(list.map((v) => Object.assign({ label: lane.label }, v)));
  }
}
```

## 加锚点的写法（Windows 泳道）

```js
// lib/anchors/hermes-win.js
const label = '0.21.1';           // 换成宿主真实版本
module.exports = { label, map: {
  C13: [{ file: 'agent/xxx.py', kind: 'splice',
    find: `            api_messages = [{"role": "system", "content": effective_system}] + api_messages\n`,
    to: `            # [hermes-purge] C13 改为 in-history user 注入
            api_messages = [{"role": "user", "content": effective_system}, {"role": "assistant", "content": "ok"}] + api_messages\n` }],
} };
```

要求：`find` 带真实缩进（文本层在 LF 视图匹配、写回恢复原 EOL），`to` 缩进一致且保留
`[hermes-purge]` 标记；不确定先 `purge apply --dry`。

## 同步方式

```bash
# mac 泳道
git checkout lane/mac && git pull --rebase origin main   # 定期把 main 拉进来
git push origin lane/mac

# win 泳道
git checkout lane/win && git pull --rebase origin main
git push origin lane/win
```

`rebase` 到 `main` 时如果碰到 `CHANGELOG.md` 冲突：两边内容都保留，只是顺序不同。
