'use strict';
/**
 * test/v2.js —— v2 引擎自检（不联网、不需要真 Hermes）
 *
 *   node test/v2.js          单元
 *   node test/v2.js --e2e DIR  额外对某个 Hermes 树做一次 apply/verify/revert 闭环
 *
 * 覆盖：跨平台读写（CRLF/BOM）、python/venv 发现（Win+POSIX 两种布局）、
 *       site-packages 解析、事务与漂移拒绝、AST 助手、shim 模板可解析、cap 清单完整性。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const platform = require('../lib/v2/platform');
const txn = require('../lib/v2/txn');
const shim = require('../lib/v2/shim');
const impls = require('../lib/v2/impls');
const ast = require('../lib/v2/ast');
const capsLib = require('../lib/v2/caps');
const metrics = require('../lib/v2/metrics');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-v2-'));
// 宿主 python 优先：PY 显式指定 > 项目 venv > PATH 上真能跑 python 3 的那个。
// 不能直接 which('python3')：Windows 上它常是 pyenv-win 的 python3.bat 代理，
// Node ≥20 的 spawnSync 跑 .bat 会 EINVAL（Mac/Linux 没这个问题）。
const py = platform.pickPython(path.join(__dirname, '..'));

/* ───────────── 文本：CRLF / BOM ───────────── */

console.log('\n跨平台文本读写');

t('CRLF 文件读进来能识别', () => {
  const f = path.join(tmp, 'crlf.py');
  fs.writeFileSync(f, 'def a():\r\n    return 1\r\n');
  const r = platform.readText(f);
  assert.strictEqual(r.eol, '\r\n');
});

t('写回后仍然是 CRLF（不把 Windows 文件改成 LF）', () => {
  const f = path.join(tmp, 'crlf2.py');
  fs.writeFileSync(f, 'a = 1\r\n');
  const r = platform.readText(f);
  platform.writeText(f, 'a = 1\nb = 2', { eol: r.eol, bom: r.bom });
  const raw = fs.readFileSync(f, 'utf8');
  assert.ok(raw.includes('\r\n'), 'CRLF 丢了: ' + JSON.stringify(raw));
  assert.ok(!/[^\r]\n/.test(raw), '混进了裸 LF');
});

t('BOM 保留', () => {
  const f = path.join(tmp, 'bom.py');
  fs.writeFileSync(f, '\ufeffx = 1\n');
  const r = platform.readText(f);
  assert.strictEqual(r.bom, '\ufeff');
  platform.writeText(f, 'x = 2', { bom: r.bom, eol: r.eol });
  assert.ok(fs.readFileSync(f).slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
});

/* ───────────── venv / site-packages 双布局 ───────────── */

console.log('\n解释器与 site-packages 发现');

t('POSIX 布局 venv/bin/python + lib/python3.11/site-packages', () => {
  const root = path.join(tmp, 'posix');
  fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'venv', 'lib', 'python3.11', 'site-packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'venv', 'bin', 'python'), '');
  const found = platform.findPython(root);
  assert.ok(found && found.endsWith(path.join('bin', 'python')));
  const sps = platform.sitePackages(root);
  assert.ok(sps.some((p) => p.includes('python3.11')));
});

t('Windows 布局 venv/Scripts/python.exe + Lib/site-packages', () => {
  const root = path.join(tmp, 'win');
  fs.mkdirSync(path.join(root, 'venv', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'venv', 'Lib', 'site-packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'venv', 'Scripts', 'python.exe'), '');
  const found = platform.findPython(root);
  assert.ok(found && found.endsWith('python.exe'), 'got ' + found);
  const sps = platform.sitePackages(root);
  assert.ok(sps.some((p) => p.endsWith(path.join('Lib', 'site-packages'))), JSON.stringify(sps));
});

t('符号定位：def / class / 模块级赋值 都能找到', () => {
  const root = path.join(tmp, 'sym');
  fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pkg', 'm.py'),
    'FLAG = False\n\ndef f(a):\n    return a\n\nclass C:\n    def g(self):\n        return 1\n');
  assert.strictEqual(platform.findSymbol(root, 'f')[0].kind, 'def');
  assert.strictEqual(platform.findSymbol(root, 'C')[0].kind, 'class');
  assert.strictEqual(platform.findSymbol(root, 'FLAG')[0].kind, 'assign');
  assert.strictEqual(platform.findSymbol(root, 'nope').length, 0);
});

/* ───────────── AST 助手 ───────────── */

console.log('\nAST 层');

if (py) {
  t('force-return 插到函数体第一条', () => {
    const f = path.join(tmp, 'ast1.py');
    fs.writeFileSync(f, 'def f(x):\n    """doc"""\n    return x\n');
    const r = ast.forceReturn(py, f, 'f', 'True');
    assert.ok(r.ok, JSON.stringify(r));
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(/def f\(x\):\n    return True\n/.test(body), body);
  });

  t('force-return 幂等', () => {
    const f = path.join(tmp, 'ast1.py');
    const r = ast.forceReturn(py, f, 'f', 'True');
    assert.ok(r.ok && r.changed === false, JSON.stringify(r));
  });

  t('set-assign 改模块级赋值', () => {
    const f = path.join(tmp, 'ast2.py');
    fs.writeFileSync(f, '_F: bool = False  # note\n');
    const r = ast.setAssign(py, f, '_F', 'True');
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(fs.readFileSync(f, 'utf8').includes('_F: bool = True'), fs.readFileSync(f, 'utf8'));
  });

  t('CRLF 文件被 AST 改完仍是 CRLF', () => {
    const f = path.join(tmp, 'ast3.py');
    fs.writeFileSync(f, 'def g():\r\n    return 0\r\n');
    ast.forceReturn(py, f, 'g', 'True');
    const raw = fs.readFileSync(f, 'utf8');
    assert.ok(raw.includes('return True\r\n'), JSON.stringify(raw));
  });

  t('符号不存在时返回 ok:false 而不是抛栈', () => {
    const f = path.join(tmp, 'ast4.py');
    fs.writeFileSync(f, 'x = 1\n');
    const r = ast.forceReturn(py, f, 'missing', 'True');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'symbol-not-found');
  });
} else {
  console.log('  - 跳过 AST（本机无 python3）');
}

/* ───────────── shim 模板 ───────────── */

console.log('\nshim 层');

t('模板是合法 python（true/false 已转 True/False）', () => {
  const src = shim.render([{ cap: 'C01', module: 'tools.approval', attr: '_F', mode: 'const', value: true }], '/tmp/x.log');
  assert.ok(!/:\s*true\b/.test(src), '出现了 JS 字面量 true');
  assert.ok(src.includes('True'));
  if (py) {
    const f = path.join(tmp, 'shim_check.py');
    fs.writeFileSync(f, src);
    const r = platform.spawnAny(py, ['-c', `import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())`, f],
      { env: platform.pyEnv() });
    assert.strictEqual(r.status, 0, String(r.stderr));
  }
});

t('Windows 路径能被写进 python 字面量', () => {
  const src = shim.render([], 'C:\\Users\\x\\.hermes\\purge\\shim.log');
  assert.ok(src.includes('C:\\\\Users'), '反斜杠未转义: ' + src.split('\n').find((l) => l.startsWith('_LOG')));
});

/* ───────────── 事务 ───────────── */

console.log('\n事务与回滚');

t('apply → revert 逐字节还原', () => {
  const root = path.join(tmp, 'txn1');
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  const f = path.join(root, 'a', 'x.py');
  fs.writeFileSync(f, 'one\n');
  const snap = txn.begin(root, ['a/x.py']);
  fs.writeFileSync(f, 'two\n');
  txn.commit(snap);
  const r = txn.revert(root);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'one\n');
});

t('外部手改过 → 默认拒绝覆盖', () => {
  const root = path.join(tmp, 'txn2');
  fs.mkdirSync(root, { recursive: true });
  const f = path.join(root, 'y.py');
  fs.writeFileSync(f, 'orig\n');
  const snap = txn.begin(root, ['y.py']);
  fs.writeFileSync(f, 'patched\n');
  txn.commit(snap);
  fs.writeFileSync(f, 'user-edit\n');
  const r = txn.revert(root);
  assert.strictEqual(r.ok, false);
  assert.ok(r.drifted.some((d) => d.includes('y.py')));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'user-edit\n', '不该覆盖用户手改');
});

t('--force 才强上', () => {
  const root = path.join(tmp, 'txn2');
  const r = txn.revert(root, { force: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(root, 'y.py'), 'utf8'), 'orig\n');
});

t('二次 apply 不会丢掉第一份快照', () => {
  const root = path.join(tmp, 'txn3');
  fs.mkdirSync(root, { recursive: true });
  const f = path.join(root, 'z.py');
  fs.writeFileSync(f, 'v0\n');
  const s1 = txn.begin(root, ['z.py']);
  fs.writeFileSync(f, 'v1\n');
  txn.commit(s1);
  const s2 = txn.begin(root, ['z.py']);
  fs.writeFileSync(f, 'v2\n');
  txn.commit(s2);
  assert.strictEqual(txn.listSnapshots(root).length, 2);
  txn.revert(root, { id: s1.id });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v0\n');
});

/* ───────────── 文本实现 ───────────── */

console.log('\n文本实现');

t('replace 已应用但没带 cap id 的老补丁 → applied（不能误报 drifted）', () => {
  const root = path.join(tmp, 'legacy');
  fs.mkdirSync(root, { recursive: true });
  const oldTo = '# [hermes-purge] 老版本注入\nX = 2';
  fs.writeFileSync(path.join(root, 'a.py'), oldTo + '\n');
  const sp = { file: 'a.py', kind: 'replace', find: 'X = 1', to: oldTo };
  const ctx = { target: root };
  assert.strictEqual(impls.probeText(sp, 'C13', ctx).status, 'applied');
  fs.writeFileSync(path.join(root, 'a.py'), 'X = 1\n');
  assert.strictEqual(impls.probeText(sp, 'C13', ctx).status, 'pending');
  fs.writeFileSync(path.join(root, 'a.py'), 'Y = 0\n');
  assert.strictEqual(impls.probeText(sp, 'C13', ctx).status, 'drifted');
});

t('yamlApprovals：只有 timeout 没有 mode 时也要补上 mode（否则永远 pending）', () => {
  const root = path.join(tmp, 'cfg1');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  default: x\napprovals:\n  timeout: 86400\n');
  const sp = { file: 'config.yaml', kind: 'yamlApprovals' };
  const ctx = { target: root };
  assert.strictEqual(impls.probeText(sp, 'G01', ctx).status, 'pending');
  assert.ok(impls.applyText(sp, 'G01', ctx).changed);
  assert.strictEqual(impls.probeText(sp, 'G01', ctx).status, 'applied');
  const y = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8');
  // 顺序不固定（上游实现是「有就改、没有就追加」），只断言键值都在，且都在 approvals 段里
  assert.ok(/^\s+mode: 'off'/m.test(y), y);
  assert.ok(/^\s+timeout: 86400/m.test(y), y);

  // 宿主回写成 mode: smart 的也要改回 off，且不能把 MARK 叠两遍
  const root2 = path.join(tmp, 'cfg2');
  fs.mkdirSync(root2, { recursive: true });
  fs.writeFileSync(path.join(root2, 'config.yaml'),
    "approvals:\n  timeout: 86400  # [hermes-purge]  # [hermes-purge]\n  mode: smart\n");
  const ctx2 = { target: root2 };
  assert.strictEqual(impls.probeText(sp, 'G01', ctx2).status, 'pending');
  impls.applyText(sp, 'G01', ctx2);
  assert.strictEqual(impls.probeText(sp, 'G01', ctx2).status, 'applied');
  const y2 = fs.readFileSync(path.join(root2, 'config.yaml'), 'utf8');
  assert.ok(/mode: 'off'/.test(y2), y2);
  // 每个键各一个标记（上游实现 mode/timeout 都写 MARK），但绝不允许同一行叠两遍
  assert.ok(!/(#\s*\[hermes-purge\])(\s*#\s*\[hermes-purge\])+/.test(y2), y2);
  for (const line of y2.split('\n')) {
    assert.ok((line.match(/\[hermes-purge\]/g) || []).length <= 1, line);
  }
});

t('win 泳道的变体能加载进 cap（hermes-win.js 被 patches.js 装载）', () => {
  const { PATCHES } = require('../lib/patches');
  const c20b = PATCHES.find((p) => p.id === 'C20b');
  assert.ok(c20b && Array.isArray(c20b.variants) && c20b.variants.length >= 1, 'C20b 没有 win 变体');
  assert.ok(c20b.variants.some((v) => v.label === 'win-lane' && /chat_completions\.py$/.test(v.file)),
    JSON.stringify(c20b.variants));
});

t('yamlToolOutput：缺段就注入，值小了就抬高，幂等', () => {
  const root = path.join(tmp, 'cfg3');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'config.yaml');
  fs.writeFileSync(file, 'model:\n  default: x\n');
  const sp = { file: 'config.yaml', kind: 'yamlToolOutput',
    limits: { max_bytes: 4000000, max_lines: 20000, max_line_length: 20000 } };
  const ctx = { target: root };
  assert.strictEqual(impls.probeText(sp, 'G03', ctx).status, 'pending');
  assert.ok(impls.applyText(sp, 'G03', ctx).changed);
  assert.strictEqual(impls.probeText(sp, 'G03', ctx).status, 'applied');
  const y = fs.readFileSync(file, 'utf8');
  assert.ok(/^tool_output:\s*$/m.test(y), y);
  assert.ok(/max_lines: 20000/.test(y), y);
  assert.ok(!impls.applyText(sp, 'G03', ctx).changed, '第二次不该再写');

  // 上游写回默认值 → 必须判 pending 并抬回去
  fs.writeFileSync(file, 'tool_output:\n  max_bytes: 50000\n  max_lines: 2000\n  max_line_length: 2000\n');
  assert.strictEqual(impls.probeText(sp, 'G03', ctx).status, 'pending');
  impls.applyText(sp, 'G03', ctx);
  assert.strictEqual(impls.probeText(sp, 'G03', ctx).status, 'applied');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    assert.ok((line.match(/\[hermes-purge\]/g) || []).length <= 1, line);
  }
});

t('C26 深度替换带 cap 标记且幂等', () => {
  const { PATCHES } = require('../lib/patches');
  const c26 = PATCHES.find((p) => p.id === 'C26');
  assert.ok(c26, 'C26 缺失');
  const root = path.join(tmp, 'depth');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'delegate.py');
  fs.writeFileSync(file, c26.find + '\n');
  const ctx = { target: root };
  const sp = Object.assign({}, c26, { file: 'delegate.py' });
  assert.strictEqual(impls.probeText(sp, 'C26', ctx).status, 'pending');
  assert.ok(impls.applyText(sp, 'C26', ctx).changed);
  assert.strictEqual(impls.probeText(sp, 'C26', ctx).status, 'applied');
  const y = fs.readFileSync(file, 'utf8');
  assert.ok(/MAX_DEPTH = 6/.test(y) && /\[hermes-purge\] C26/.test(y), y);
  assert.ok(!impls.applyText(sp, 'C26', ctx).changed, '第二次不该再写');
});

t('C27 方法级插入要缩进 8 格（4 格会 IndentationError）', () => {
  const { PATCHES } = require('../lib/patches');
  const c27 = PATCHES.find((p) => p.id === 'C27');
  assert.ok(c27, 'C27 缺失');
  const root = path.join(tmp, 'prune');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'prune.py');
  fs.writeFileSync(file, 'class M:\n' + c27.anchor + '\n        return True\n');
  const ctx = { target: root };
  const sp = Object.assign({}, c27, { file: 'prune.py' });
  assert.ok(impls.applyText(sp, 'C27', ctx).changed);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.includes('return False'));
  assert.ok(idx > 0, lines.join('|'));
  assert.strictEqual(lines[idx].match(/^ */)[0].length, 8, JSON.stringify(lines[idx]));
});

t('splice 幂等（sentinel 判定）', () => {
  const root = path.join(tmp, 'txt');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'm.py'), 'logger = logging.getLogger(__name__)\n');
  const sp = { file: 'm.py', kind: 'splice', find: 'logger = logging.getLogger(__name__)\n',
    to: 'logger = logging.getLogger(__name__)\nX = 1  # [hermes-purge] C99\n' };
  const ctx = { target: root };
  assert.strictEqual(impls.probeText(sp, 'C99', ctx).status, 'pending');
  const a = impls.applyText(sp, 'C99', ctx);
  assert.ok(a.changed);
  assert.strictEqual(impls.probeText(sp, 'C99', ctx).status, 'applied');
  const b = impls.applyText(sp, 'C99', ctx);
  assert.ok(!b.changed, '第二次不该再写');
});

/* ───────────── cap 清单 ───────────── */

console.log('\ncap 清单');

const caps = capsLib.buildCaps();

t('41 条 cap，id 唯一', () => {
  assert.strictEqual(caps.length, 41);
  assert.strictEqual(new Set(caps.map((c) => c.id)).size, 41);
});

t('H 系列（宿主防护层）全部在册，且都有 AST 层', () => {
  for (const id of ['C21', 'C22', 'C22b', 'C23', 'C23b', 'C24', 'C25', 'C27']) {
    const c = caps.find((x) => x.id === id);
    assert.ok(c, id + ' 缺失');
    assert.ok(c.impls.map((i) => i.kind).includes('ast'), id + ' 没有 AST 路径：' + c.impls.map((i) => i.kind));
  }
});

t('每条 cap 至少一个实现，且最后一级是文本/配置层', () => {
  for (const c of caps) {
    assert.ok(c.impls.length >= 1, c.id);
    assert.strictEqual(c.impls[c.impls.length - 1].kind, 'text', c.id);
  }
});

t('安全核心（C01-C12）都有 AST + shim 双路径', () => {
  for (const id of ['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C11', 'C12']) {
    const c = caps.find((x) => x.id === id);
    const kinds = c.impls.map((i) => i.kind);
    assert.ok(kinds.includes('ast') && kinds.includes('shim'), id + ': ' + kinds.join(','));
  }
});

t('shim 条目覆盖安全核心，且每条带 cap 标签', () => {
  const entries = [];
  for (const c of caps) if (c.shimMeta) entries.push(...capsLib.shimEntriesFor(c).map((e) => Object.assign({ cap: c.id }, e)));
  assert.ok(entries.length >= 14, '条目数 ' + entries.length);
  assert.ok(entries.every((e) => e.cap && e.module && e.attr));
});

/* ───────────── 每轮埋点（P4） ───────────── */

console.log('\n每轮埋点');

/** 假宿主：run_conversation 自己累加 token；user_message="boom" 时抛错 */
const FAKE_HOST_MOD = [
  'def run_conversation(agent, user_message, system_message=None):',
  '    if user_message == "boom":',
  '        raise RuntimeError("host-fail")',
  '    agent.session_input_tokens = (agent.session_input_tokens or 0) + 120',
  '    agent.session_output_tokens = (agent.session_output_tokens or 0) + 30',
  '    return {"final_response": "ok"}',
  '',
].join('\n');

// 注意：一律用 `-S` 跑，且按文件路径装载 shim ——
// 否则若 PY 指向本机已装的 Hermes venv，它的 site-packages/.pth 会先导入真机
// 那份 shim（污染真实 .hermes-purge 日志，也不是我们要测的代码）。
const TURN_DRIVER = [
  'import importlib.util, os, sys',
  'sys.path.insert(0, sys.argv[1])',
  // Windows 上 `python -S -c` 不保证把 cwd 放进 sys.path，显式加一次（agent 包在 cwd 下）
  'sys.path.insert(0, os.getcwd())',
  'sys.modules.pop("_hermes_purge_shim", None)',
  'spec = importlib.util.spec_from_file_location("_hermes_purge_shim", sys.argv[2])',
  'mod = importlib.util.module_from_spec(spec)',
  'sys.modules["_hermes_purge_shim"] = mod',
  'spec.loader.exec_module(mod)   # 装上 meta_path 钩子',
  'from agent import conversation_loop as cl',
  '',
  'class A(object):',
  '    platform = "cli"',
  '    model = "claude-sonnet-4"',
  '    session_input_tokens = 100',
  '    session_output_tokens = 20',
  '',
  'a = A()',
  'a._purge_refusal_nudges = 2   # 实例属性：C18c 就是挂在 agent 上的',
  'cl.run_conversation(a, "hi")',
  'a._purge_refusal_nudges = 0',
  'cl.run_conversation(a, "again")',
  'try:',
  '    cl.run_conversation(a, "boom")',
  '    print("NO-RAISE")',
  'except RuntimeError:',
  '    print("RAISED")',
  'del a._purge_refusal_nudges',
  'cl.run_conversation(a, "no-counter")',
  'print("DONE")',
].join('\n');

let turnRun = null;
if (py) {
  const root = path.join(tmp, 'turn1');
  fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent', '__init__.py'), '');
  fs.writeFileSync(path.join(root, 'agent', 'conversation_loop.py'), FAKE_HOST_MOD);
  const sp = path.join(root, 'site-packages');
  fs.mkdirSync(sp, { recursive: true });
  const v2dir = path.join(root, '.hermes-purge', 'v2');
  fs.mkdirSync(v2dir, { recursive: true });
  const logFile = path.join(v2dir, 'shim.log');
  const metricsFile = path.join(v2dir, 'metrics.jsonl');
  fs.writeFileSync(path.join(sp, shim.SHIM_NAME), shim.render([], logFile, metricsFile));
  const r = platform.spawnAny(py, ['-S', '-c', TURN_DRIVER, sp, path.join(sp, shim.SHIM_NAME)],
    { encoding: 'utf8', cwd: root, timeout: 120000, env: platform.pyEnv() });
  turnRun = { root, r, rows: metrics.read(root) };
}

if (!turnRun) {
  console.log('  - 跳过埋点用例（本机无 python3，可设 PY=/path/to/python）');
} else {
  t('turn 钩子：跑一轮就落一条记录，字段齐全', () => {
    const { r, rows } = turnRun;
    // 失败时把完整 stderr 带出来：Windows 上的 python 报错只留最后三行根本不够定位
    const diag = '\n--- stdout ---\n' + (r.stdout || '').slice(-800) + '\n--- stderr ---\n' + (r.stderr || '').slice(-2000);
    assert.strictEqual(r.status, 0, diag);
    assert.strictEqual(rows.length, 4, '记录数 ' + rows.length + diag);
    const rec = rows[0];
    for (const k of ['ts', 'surface', 'model', 'turn', 'refusals', 'approval', 'tokens', 'ok']) {
      assert.ok(Object.prototype.hasOwnProperty.call(rec, k), '缺字段 ' + k);
    }
    assert.strictEqual(rec.surface, 'cli');
    assert.strictEqual(rec.model, 'claude-sonnet-4');
    assert.strictEqual(rec.turn, 1);
    assert.deepStrictEqual(rec.refusals, { nudges: 2, hit: true });
    assert.ok(rec.approval && Object.prototype.hasOwnProperty.call(rec.approval, 'mode'));
    assert.deepStrictEqual(rec.tokens, { in: 120, out: 30 });
    assert.strictEqual(rec.ok, true);
    assert.ok(!isNaN(Date.parse(rec.ts)), 'ts 不是合法时间: ' + rec.ts);
    // 第二轮：计数被清零 → hit false，但 turn 序号递增
    assert.strictEqual(rows[1].turn, 2);
    assert.strictEqual(rows[1].refusals.hit, false);
  });

  t('turn 钩子：宿主流异常 → ok:false 且不吞异常', () => {
    const { r, rows } = turnRun;
    assert.ok((r.stdout || '').includes('RAISED'), '异常被吞了: ' + (r.stdout || '') + (r.stderr || ''));
    assert.strictEqual(rows[2].turn, 3);
    assert.strictEqual(rows[2].ok, false);
  });

  t('turn 钩子：agent 上没有 _purge_refusal_nudges 时安全读成 null', () => {
    const last = turnRun.rows[3];
    assert.strictEqual(last.refusals.nudges, null);
    assert.strictEqual(last.refusals.hit, false);
    assert.strictEqual(last.ok, true);
  });
}

/* ───────────── stats 聚合 ───────────── */

const statsRoot = path.join(tmp, 'stats1');
fs.mkdirSync(path.join(statsRoot, '.hermes-purge', 'v2'), { recursive: true });
fs.writeFileSync(path.join(statsRoot, '.hermes-purge', 'v2', 'metrics.jsonl'), [
  { event: 'turn', ts: '2026-11-17T10:00:00.000Z', surface: 'cli', model: 'claude-sonnet-4', turn: 1,
    refusals: { nudges: 2, hit: true }, approval: { mode: 'off' }, tokens: { in: 1000, out: 200 }, ok: true },
  { event: 'turn', ts: '2026-11-17T10:01:00.000Z', surface: 'cli', model: 'claude-sonnet-4', turn: 2,
    refusals: { nudges: 1, hit: true }, approval: { mode: 'off' }, tokens: { in: 800, out: 150 }, ok: true },
  { event: 'turn', ts: '2026-11-17T10:02:00.000Z', surface: 'dashboard', model: 'mystery-1', turn: 3,
    refusals: { nudges: 0, hit: false }, approval: { mode: null }, tokens: { in: 200, out: 100 }, ok: false },
  { event: 'turn', ts: '2026-11-17T10:03:00.000Z', surface: 'dashboard', model: 'mystery-1', turn: 4,
    refusals: { nudges: null, hit: false }, approval: { mode: null }, tokens: { in: 100, out: 100 }, ok: true },
  { at: '2026-11-17T09:00:00.000Z', event: 'apply', changed: 31, skipped: 0, failed: 0, shim: 14 },
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

fs.writeFileSync(path.join(statsRoot, '.hermes-purge', 'v2', 'shim.log'), [
  { ok: true, module: 'tools.approval', attr: '_YOLO_MODE_FROZEN', mode: 'const', cap: 'C01' },
  { ok: true, module: 'tools.approval', attr: '_YOLO_MODE_FROZEN', mode: 'const', cap: 'C01' },
  { ok: true, module: 'tools.approval', attr: 'is_approval_bypass_active', mode: 'true', cap: 'C03' },
  { ok: false, module: 'tools.approval_context', attr: '_get_approval_mode', err: 'attr-missing', cap: 'C04' },
  { ok: true, module: 'agent.conversation_loop', attr: 'run_conversation', mode: 'turn-hook' },
].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

t('stats 聚合：轮次 / 拒答命中 / 平均重采样 / tokens 计数正确', () => {
  const s = metrics.stats(statsRoot);
  assert.strictEqual(s.turnRows, 4);
  assert.strictEqual(s.eventRows, 1);
  assert.strictEqual(s.hasTurns, true);
  assert.strictEqual(s.refusalHits, 2);
  assert.strictEqual(s.refusalRate, 0.5);
  assert.strictEqual(s.nudgeTotal, 3);
  assert.strictEqual(s.avgNudges, 0.75);
  assert.strictEqual(s.nudgeMissing, 1);
  assert.strictEqual(s.failedTurns, 1);
  assert.deepStrictEqual(s.tokens, { in: 2100, out: 550, total: 2650, turns: 4, turnsMissing: 0 });
  assert.strictEqual(s.surfaces.cli, 2);
  assert.strictEqual(s.models['claude-sonnet-4'], 2);
  assert.strictEqual(s.eventsByType.apply, 1);
});

t('stats 聚合：cap 命中只数 shim.log 里带 cap 的行', () => {
  const s = metrics.stats(statsRoot);
  assert.strictEqual(s.byCap.C01, 2);
  assert.strictEqual(s.byCap.C03, 1);
  assert.strictEqual(s.capFails.C04, 1);
  assert.strictEqual(s.capRows, 4);
  assert.strictEqual(s.capUnlabeled, 1, 'turn-hook 行不该算 cap 命中');
});

t('stats 成本：价目表可覆盖，未定价模型给 null 不给 0', () => {
  const prices = { 'claude-sonnet-4': { in: 3, out: 15 }, mystery: { in: 1, out: 2 } };
  const s = metrics.stats(statsRoot, { prices });
  // claude: 1800in/350out → 1800/1e6*3 + 350/1e6*15 = 0.01065
  // mystery: 300in/200out → 0.0003 + 0.0004 = 0.0007
  assert.ok(Math.abs(s.cost.usd - 0.01135) < 1e-9, '成本 ' + s.cost.usd);
  assert.strictEqual(s.cost.pricedModels, 2);
  assert.strictEqual(s.cost.unpricedModels, 0);

  const none = metrics.stats(statsRoot, { prices: {} });
  assert.strictEqual(none.cost.usd, null, '没有价目就不该给数字');
  assert.deepStrictEqual(none.cost.unpriced.sort(), ['claude-sonnet-4', 'mystery-1']);
});

t('stats 空树：明确「没有轮次数据」，不编 0 成本', () => {
  const empty = path.join(tmp, 'stats-empty');
  fs.mkdirSync(empty, { recursive: true });
  const s = metrics.stats(empty);
  assert.strictEqual(s.hasTurns, false);
  assert.strictEqual(s.turnRows, 0);
  assert.strictEqual(s.avgNudges, null);
  assert.strictEqual(s.cost.usd, null);
});

/* ───────────── shim 里的 turn 钩子代码本身 ───────────── */

t('shim 模板含 turn 钩子且仍是合法 python（Windows 路径也过）', () => {
  const src = shim.render(
    [{ cap: 'C01', module: 'tools.approval', attr: '_F', mode: 'const', value: true }],
    'C:\\Users\\x\\.hermes-purge\\v2\\shim.log',
    'C:\\Users\\x\\.hermes-purge\\v2\\metrics.jsonl');
  for (const needle of ['_purge_make_turn_wrapper', '_purge_emit_turn', 'agent.conversation_loop', 'metrics.jsonl']) {
    assert.ok(src.includes(needle), '缺 ' + needle);
  }
  if (!py) return;
  const f = path.join(tmp, 'shim_p4.py');
  fs.writeFileSync(f, src, 'utf8');
  const r = platform.spawnAny(py, ['-S', '-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())', f],
    { encoding: 'utf8', timeout: 60000, env: platform.pyEnv() });
  assert.strictEqual(r.status, 0, String(r.stderr));
});

/* ───────────── 可选的树级闭环 ───────────── */

if (process.argv.includes('--e2e')) {
  const idx = process.argv.indexOf('--e2e');
  const dir = process.argv[idx + 1];
  if (!dir || dir.startsWith('--')) {
    console.log('\n跳过树级闭环：--e2e 后面要给一个 Hermes 树目录（例：--e2e /tmp/hermes-tree）');
    console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
    process.exit(fail === 0 ? 0 : 1);
  }
  console.log('\n树级闭环（' + dir + '）');
  const purge = path.join(__dirname, '..', 'bin', 'purge.js');
  const run = (a) => spawnSync(process.execPath, [purge].concat(a, ['--target=' + dir]), { encoding: 'utf8' });
  t('apply 无失败项', () => {
    const r = run(['apply']);
    assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  });
  t('verify L2 全绿', () => {
    const r = run(['verify', '--level=2']);
    assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  });
  t('doctor 健康', () => {
    const r = run(['doctor']);
    assert.strictEqual(r.status, 0, r.stdout);
  });
  t('revert 干净', () => {
    const r = run(['revert']);
    assert.strictEqual(r.status, 0, r.stdout);
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);