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

console.log('\n探针报表口径（probe --stub）');

t('报表带置信区间、N<12 警告与「期望 vs 实测」口径说明', () => {
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'bin', 'probe.js'), '--stub', '--n=4', '--cases=amsi,adult'],
    { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 300));
  assert.ok(/\[0\.\d\d, 0\.\d\d\]/.test(r.stdout), '没有置信区间：' + r.stdout.slice(0, 200));
  assert.ok(r.stdout.includes('N<12'), '没有小样本警告');
  assert.ok(r.stdout.includes('几何分布'), '没有说明右列是推算值');
});

console.log('\n磁盘产物断言（bench/artifacts.js）');

const artifacts = require('../bench/artifacts');

t('快照/比对：能分出创建、修改、删除', () => {
  const fs2 = require('fs'), os2 = require('os');
  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'art-'));
  try {
    fs2.writeFileSync(path.join(dir, 'keep.py'), 'x = 1\n');
    fs2.writeFileSync(path.join(dir, 'gone.py'), 'y = 1\n');
    const before = artifacts.snapshot(dir);
    fs2.writeFileSync(path.join(dir, 'new.js'), 'const a = 1;\n');
    fs2.writeFileSync(path.join(dir, 'keep.py'), 'x = 2\n');
    fs2.unlinkSync(path.join(dir, 'gone.py'));
    const d = artifacts.diff(before, artifacts.snapshot(dir));
    assert.ok(d.created.includes('new.js'), JSON.stringify(d));
    assert.ok(d.modified.includes('keep.py'), JSON.stringify(d));
    assert.ok(d.deleted.includes('gone.py'), JSON.stringify(d));
    const c = artifacts.classify(d);
    assert.deepStrictEqual(c.code.sort(), ['keep.py', 'new.js']);
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});

t('解析：python 走 py_compile，写坏的文件要被点名', () => {
  const fs2 = require('fs'), os2 = require('os');
  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'art2-'));
  const platform = require('../lib/v2/platform');
  const py = platform.findPython('.') || platform.which('python') || platform.which('python3');
  if (!py) { console.log('    （本机没有 python，跳过）'); return; }
  try {
    fs2.writeFileSync(path.join(dir, 'ok.py'), 'x = 1\n');
    fs2.writeFileSync(path.join(dir, 'bad.py'), 'def f(:\n');
    const r = artifacts.parsability(dir, ['ok.py', 'bad.py'], py);
    assert.strictEqual(r.checked, 2);
    assert.strictEqual(r.ok, 1);
    assert.strictEqual(r.failed[0].file, 'bad.py');
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});

t('探针 --artifacts：报表里出现产物列与解析失败明细', () => {
  const fs2 = require('fs'), os2 = require('os');
  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'art3-'));
  try {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, 'bin', 'probe.js'), '--stub', '--n=4', '--cases=amsi', '--artifacts=' + dir],
      { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(r.status, 0, (r.stderr || '').slice(0, 300));
    assert.ok(r.stdout.includes('产物'), '报表没有产物列');
    assert.ok(/解析 \d+\/\d+/.test(r.stdout), '没有解析统计：' + r.stdout.slice(0, 300));
    assert.ok(r.stdout.includes('stub_amsi_1.py'), '没有点名写坏的文件');
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});

console.log('\n状态报告与徽标');

t('report.render 产出单文件 HTML，含结论/时间/回滚提示', () => {
  const report = require('../lib/v2/report');
  const d = {
    target: '/tmp/x', adapter: 'hermes', version: '9.9.9', hostVersion: '0.21.0',
    generatedAt: '2026-01-01 00:00:00',
    rows: [
      { id: 'C01', cap: 'approval.yolo_frozen', layer: 'code', impl: 'ast', status: 'applied', detail: '' },
      { id: 'C13', cap: 'prompt.system_to_user', layer: 'code', impl: 'text', status: 'pending', detail: '' },
    ],
    doctor: { checks: [{ name: '文件哈希', ok: true, detail: '一致' }] },
    stats: { turns: 3, refusalHits: 1 },
    audit: [{ at: '2026-01-01T00:00:00Z', event: 'apply', changed: 5 }],
  };
  const html = report.render(d);
  assert.ok(html.startsWith('<!doctype html>'), '不是 HTML');
  assert.ok(html.includes('部分生效'), '没给出结论');
  assert.ok(html.includes('1/2'), '没显示生效比例：' + html.slice(0, 200));
  assert.ok(html.includes('purge revert'), '没写回滚命令');
  assert.ok(html.includes('2026-01-01 00:00:00'), '没写生成时间');
  assert.ok(html.includes('approval.yolo_frozen'), '没列能力');
  assert.ok(!/<script/i.test(html), '不该有脚本（离线单文件）');
});

t('report 对空数据不炸（n/a 而不是编数）', () => {
  const report = require('../lib/v2/report');
  const html = report.render({ target: '/x', adapter: 'hermes', version: '1', rows: [], doctor: { checks: [] }, stats: {}, audit: [] });
  assert.ok(html.includes('未开启'), '空数据应判未开启');
  assert.ok(html.includes('n/a'), '空数据应显示 n/a');
});

t('hp 徽标：打开开关后能看到「已开启 / 未开启」', () => {
  const fs2 = require('fs'), os2 = require('os');
  const dir = fs2.mkdtempSync(path.join(os2.tmpdir(), 'badge-'));
  try {
    fs2.mkdirSync(path.join(dir, 'hermes-agent', 'hermes_cli'), { recursive: true });
    fs2.mkdirSync(path.join(dir, 'hermes-agent', 'agent'), { recursive: true });
    fs2.writeFileSync(path.join(dir, 'config.yaml'), 'model:\n  default: fake\n');
    // 假宿主没有可用 config，hp 会在配置检查处退出 3；徽标在退出之前打印
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'hp.js'), '--home=' + dir, '随便问一句'],
      { encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, { HERMES_PURGE_BADGE: '1', HERMES_DASH: 'http://127.0.0.1:1' }) });
    assert.ok(/\[purge 未开启/.test(r.stderr), '徽标没出现：' + (r.stderr || '').slice(0, 300));
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
