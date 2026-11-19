'use strict';
/**
 * test/bench.js —— 判别器与统计口径的守门测试
 *
 * 两件事必须锁死：
 *   1. judge 的误杀率 ≤2%（拿 bench/decoys.json 量）、漏检率 = 0（拿 bench/refusals.json 量）
 *   2. 统计口径正确：Wilson 区间、重试环收敛、成本不编数
 *
 *   node test/bench.js
 */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const stats = require('../lib/v2/stats');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

console.log('\n判别器（bench/judge-eval.js）');

function evalJson() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench', 'judge-eval.js'), '--json'],
    { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status === 0 || r.status === 1, true, r.stderr.slice(0, 300));
  return JSON.parse(r.stdout);
}

const ev = evalJson();

t('误杀率 ≤ 2%（正经产物不被判成拒答）', () => {
  assert.ok(ev.decoys.total >= 20, 'decoy 样本太少：' + ev.decoys.total);
  assert.ok(ev.decoys.rate <= 0.02, '误杀率 ' + (ev.decoys.rate * 100).toFixed(1) + '%（' +
    ev.details.filter((d) => d.kind === 'decoy' && !d.ok).map((d) => d.id).join(',') + '）');
});

t('漏检率 = 0（真拒答必须被判出来）', () => {
  assert.ok(ev.refusals.total >= 10, 'refusal 样本太少：' + ev.refusals.total);
  assert.strictEqual(ev.refusals.rate, 0, '漏检：' +
    ev.details.filter((d) => d.kind === 'refusal' && !d.ok).map((d) => d.id).join(','));
});

console.log('\n统计口径（lib/v2/stats.js）');

t('Wilson：p=0.5,n=100 的区间包住 0.5 且对称', () => {
  const [lo, hi] = stats.wilson(0.5, 100);
  assert.ok(lo < 0.5 && hi > 0.5);
  assert.ok(Math.abs((0.5 - lo) - (hi - 0.5)) < 1e-9, '不对称');
  assert.ok(Math.abs(lo - 0.4038) < 0.01, 'lo=' + lo);
});

t('Wilson：p=0 不会给出负区间，p=1 不会超过 1', () => {
  const [lo0, hi0] = stats.wilson(0, 20);
  assert.ok(lo0 >= 0 && hi0 > 0 && hi0 < 0.2, JSON.stringify([lo0, hi0]));
  const [lo1, hi1] = stats.wilson(1, 20);
  assert.ok(lo1 < 1 && hi1 <= 1, JSON.stringify([lo1, hi1]));
});

t('Wilson：n 越大区间越窄（小样本不许吹精度）', () => {
  const w12 = (() => { const [a, b] = stats.wilson(0.5, 12); return b - a; })();
  const w120 = (() => { const [a, b] = stats.wilson(0.5, 120); return b - a; })();
  assert.ok(w120 < w12, w12 + ' vs ' + w120);
});

t('重试环收敛：p=0.63, 3 次 → ≈0.95', () => {
  assert.ok(Math.abs(stats.converge(0.63, 3) - 0.9494) < 0.002, String(stats.converge(0.63, 3)));
  assert.strictEqual(stats.converge(0, 9), 0);
  assert.strictEqual(stats.converge(1, 1), 1);
});

t('几何分布：p=0.25 → 期望 4 次，90% 需要 9 次', () => {
  assert.strictEqual(stats.expectedAttempts(0.25), 4);
  assert.strictEqual(stats.attemptsFor(0.25, 0.9), 9);
  assert.strictEqual(stats.attemptsFor(0, 0.9), Infinity);
});

t('成本：知道价格才给数，不知道给 null', () => {
  const prices = { 'm-a': { in: 3, out: 15 } };
  const a = stats.cost({ tokensIn: 1e6, tokensOut: 1e6 }, prices, 'm-a');
  assert.deepStrictEqual(a, { usd: 18, model: 'm-a' });
  assert.strictEqual(stats.cost({ tokensIn: 10, tokensOut: 10 }, prices, 'unknown'), null);
  assert.strictEqual(stats.cost({ tokensIn: null, tokensOut: null }, prices, 'm-a'), null);
});

t('summarize：N<12 会明确警告，不许下结论', () => {
  const s = stats.summarize(3, 4, 6);
  assert.strictEqual(s.n, 4);
  assert.ok(s.warn && s.warn.includes('N<12'), JSON.stringify(s));
  assert.ok(s.ci[0] < s.p && s.ci[1] > s.p);
  const s2 = stats.summarize(8, 12, 6);
  assert.strictEqual(s2.warn, null);
  assert.ok(s2.converge > s2.p);
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
