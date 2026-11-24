'use strict';
/**
 * test/ast-batch.js —— 批量 locate 的缓存语义
 *
 * probe 阶段同一个文件会分多次问不同符号。缓存若「只记上次问过的」，
 * 第二个符号就会被误判成 symbol-not-found（实测让 C10 从 applied 退化成 drifted）。
 * 这里锁住：同一文件先问 a 再问 b，b 也必须找得到。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('../lib/v2/platform');
const ast = require('../lib/v2/ast');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

const py = platform.findPython(process.cwd());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-astb-'));
const file = path.join(tmp, 'mod.py');
fs.writeFileSync(file, [
  'def alpha():',
  '    return 1',
  '',
  'def beta():',
  '    return 2',
  '',
  'def gamma():',
  '    return 3',
  '',
  'class Delta:',
  '    pass',
  '',
].join('\n'));

console.log('\n批量 locate 缓存');

if (!py) {
  console.log('  - 跳过（本机没有 python3，AST 层不可用）');
  process.exit(0);
}

t('第一次问 alpha：命中', () => {
  const r = ast.locateMany(py, file, ['alpha']);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.symbols.alpha, 'alpha 没命中：' + JSON.stringify(r));
});

t('同一文件再问 beta（缓存里没有它）也必须命中', () => {
  const r = ast.locateMany(py, file, ['beta']);
  assert.ok(r.symbols.beta, '被误判成 not-found：' + JSON.stringify(r));
});

t('一次问多个：alpha/beta/gamma 都对，且行号正确', () => {
  const r = ast.locateMany(py, file, ['alpha', 'beta', 'gamma']);
  assert.strictEqual(r.symbols.alpha.line, 1);
  assert.strictEqual(r.symbols.beta.line, 4);
  assert.strictEqual(r.symbols.gamma.line, 7);
});

t('类名不会被当成函数定位（locate 只认 def）', () => {
  const r = ast.locateMany(py, file, ['Delta']);
  assert.strictEqual(r.symbols.Delta, null, '类不该被 locate 命中：' + JSON.stringify(r));
});

t('文件改了（mtime 变）之后不再用旧缓存', () => {
  fs.writeFileSync(file, 'def delta():\n    return 3\n');
  const r = ast.locateMany(py, file, ['delta', 'alpha']);
  assert.ok(r.symbols.delta, JSON.stringify(r));
  assert.strictEqual(r.symbols.alpha, null, 'alpha 已不存在，不该还在');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
