'use strict';
/**
 * test/parity-layers.js —— parity 的「按层汇总」
 *
 * 逐条比对能看出差在哪条，但两台机器对账时更想知道「哪一层缺」。
 * 这里验三件事：
 *   ① 指纹里带 layers 汇总（code/config/prompt 各自的 applied/total）
 *   ② --diff 输出按层结论，且点名缺的 cap
 *   ③ 老指纹（schema=1，没有 layer 字段）仍然能比，不炸
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'purge.js');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-pl-'));
fs.mkdirSync(path.join(tmp, 'agent'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'hermes_cli'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.yaml'), 'model:\n  default: x\n');
// 夹具要像个真宿主：shim 落 site-packages，apply 才不会按 issue #15 的约定退出 1
fs.mkdirSync(path.join(tmp, 'venv', 'Lib', 'site-packages'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'venv', 'lib', 'python3.11', 'site-packages'), { recursive: true });

const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--target=' + tmp], { encoding: 'utf8' });

console.log('\nparity 按层汇总');

// 先 apply，让指纹里有真正 applied 的 cap（否则「退化」用例没有前提）
run('apply');

const out = path.join(tmp, 'p.json');
const r = run('parity', '--out=' + out);
const snap = JSON.parse(fs.readFileSync(out, 'utf8'));

t('指纹带 layers 汇总，且总数与 caps 一致', () => {
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(snap.schema, 2);
  assert.ok(snap.layers && typeof snap.layers === 'object');
  const total = Object.values(snap.layers).reduce((a, x) => a + x.total, 0);
  assert.strictEqual(total, snap.caps.length, 'layers 总数对不上 caps');
  for (const c of snap.caps) assert.ok(c.layer, 'cap 缺 layer 字段：' + c.id);
});

t('某层整体退化时，--diff 先给按层结论并点名', () => {
  const bad = JSON.parse(JSON.stringify(snap));
  // 挑「本机确实 applied」的 cap 来退化，否则 pending→drifted 不算差异
  const pick = bad.caps.filter((c) => c.status === 'applied').slice(0, 2);
  assert.ok(pick.length >= 1, '本机没有 applied 的 cap，用例前提不成立');
  const codeIds = pick.map((c) => c.id);
  const layer = pick[0].layer;
  for (const c of pick) { c.status = 'drifted'; c.impl = null; }
  bad.layers[layer].applied -= codeIds.length;
  const f = path.join(tmp, 'bad.json');
  fs.writeFileSync(f, JSON.stringify(bad));
  const rr = run('parity', '--diff=' + f);
  assert.notStrictEqual(rr.status, 0);
  assert.ok(/按层对比/.test(rr.stdout), rr.stdout);
  const layerLine = rr.stdout.split('\n').find((l) => l.includes(layer));
  assert.ok(layerLine && layerLine.includes('✖'), layer + ' 层没标红：' + layerLine);
  for (const id of codeIds) assert.ok(layerLine.includes(id), layer + ' 行没点名 ' + id + '：' + layerLine);
});

t('老指纹（schema=1，无 layer/layers）仍能比对', () => {
  const old = JSON.parse(JSON.stringify(snap));
  old.schema = 1;
  delete old.layers;
  for (const c of old.caps) delete c.layer;
  const f = path.join(tmp, 'old.json');
  fs.writeFileSync(f, JSON.stringify(old));
  const rr = run('parity', '--diff=' + f);
  assert.strictEqual(rr.status, 0, rr.stdout + rr.stderr);
  assert.ok(rr.stdout.includes('两边效果一致'), rr.stdout);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
