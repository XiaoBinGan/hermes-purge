'use strict';
/**
 * test/parity.js —— 跨机「效果指纹」对账（mac ↔ win）
 *
 * 为什么单独一个测试：两条泳道要保证「效果一样」，就需要一个与机器无关的指纹
 * （不带路径、不带 python、不带耗时），并且能 diff。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'purge.js');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  \u2714 ' + name); } catch (e) { fail++; console.log('  \u2716 ' + name + '  \u2192 ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-parity-'));
fs.mkdirSync(path.join(tmp, 'agent'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'hermes_cli'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.yaml'), 'model:\n  default: x\n');

const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--target=' + tmp], { encoding: 'utf8' });

console.log('\n效果指纹（parity）');

t('--out 产出稳定 JSON：只有 id/cap/status/impl，不含本机路径', () => {
  const out = path.join(tmp, 'p.json');
  const r = run('parity', '--out=' + out);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(j.schema, 1);
  assert.strictEqual(j.caps.length, 71);
  assert.ok(j.summary && typeof j.summary.applied === 'number');
  for (const c of j.caps) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['cap', 'id', 'impl', 'status']);
  }
  assert.ok(!JSON.stringify(j).includes(tmp), '不该带本机路径');
});

t('--diff 对同一份指纹报「一致」且退出码 0', () => {
  const out = path.join(tmp, 'p2.json');
  run('parity', '--out=' + out);
  const r = run('parity', '--diff=' + out);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('两边效果一致'), r.stdout);
});

t('--diff 对退化指纹报差异、点名具体 cap、非 0 退出', () => {
  const out = path.join(tmp, 'p3.json');
  run('parity', '--out=' + out);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  const target = j.caps[0];
  target.status = target.status === 'applied' ? 'drifted' : 'applied';
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify(j));
  const r = run('parity', '--diff=' + bad);
  assert.notStrictEqual(r.status, 0, '应该非 0 退出');
  assert.ok(/发现 \d+ 处差异/.test(r.stdout), r.stdout);
  assert.ok(r.stdout.includes(target.id), '要点名具体 cap：' + r.stdout);
});

t('--diff 能识别对端缺少某条 cap', () => {
  const out = path.join(tmp, 'p4.json');
  run('parity', '--out=' + out);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  const dropped = j.caps.pop().id;
  const f = path.join(tmp, 'drop.json');
  fs.writeFileSync(f, JSON.stringify(j));
  const r = run('parity', '--diff=' + f);
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stdout.includes(dropped) && /对端没有这条/.test(r.stdout), r.stdout);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
