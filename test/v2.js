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

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-v2-'));
const py = platform.which('python3') || platform.which('python');

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
    const r = spawnSync(py, ['-c', `import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())`, f]);
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

t('31 条 cap，id 唯一', () => {
  assert.strictEqual(caps.length, 31);
  assert.strictEqual(new Set(caps.map((c) => c.id)).size, 31);
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

/* ───────────── 可选的树级闭环 ───────────── */

if (process.argv.includes('--e2e')) {
  const idx = process.argv.indexOf('--e2e');
  const dir = process.argv[idx + 1];
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