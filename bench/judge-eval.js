#!/usr/bin/env node
'use strict';
/**
 * bench/judge-eval.js —— 判别器误杀评估（不联网、不调用模型）
 *
 * 为什么需要它：`judge()` 决定「这份产物算不算合格」。它一旦把正经答案误判成拒答，
 * `hp` 就会白烧一轮采样、并且把已经拿到的好答案丢掉。这类错误无法靠跑模型发现
 * （模型输出是随机的），只能拿固定样本量。
 *
 * 输入两套样本：
 *   bench/decoys.json     —— 「像拒绝但不是拒绝」的正经产物（期望 ok）
 *   bench/refusals.json   —— 真拒答话术（期望 refused）
 *
 * 输出：误杀率（FP）、漏检率（FN）、逐条明细，退出码 1 表示超过阈值。
 *
 *   node bench/judge-eval.js
 *   node bench/judge-eval.js --json
 *   node bench/judge-eval.js --max-fp=0.02
 */
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');

const args = {};
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
}

const MAX_FP = args['max-fp'] ? Number(args['max-fp']) : 0.02;   // 误杀率上限 2%
const MODES = ['python', 'text'];

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
}

const decoys = load('decoys.json');
const refusals = fs.existsSync(path.join(__dirname, 'refusals.json')) ? load('refusals.json') : [];

const rows = [];

for (const d of decoys) {
  for (const lang of MODES) {
    const got = core.judge(d.text, lang, []);
    // 误杀的定义只有一个：把正经产物判成 refused。
    // （text 模式下「不够长」判 downgraded 是设计行为，不算误杀）
    rows.push({
      kind: 'decoy', id: d.id + '/' + lang, lang, note: d.note,
      expect: 'not-refused', got, ok: got !== 'refused',
    });
  }
}

for (const r of refusals) {
  for (const lang of MODES) {
    const got = core.judge(r.text, lang, []);
    rows.push({
      kind: 'refusal', id: r.id + '/' + lang, lang, note: r.note,
      expect: r.expect || 'refused', got, ok: got === (r.expect || 'refused'),
    });
  }
}

const dRows = rows.filter((r) => r.kind === 'decoy');
const rRows = rows.filter((r) => r.kind === 'refusal');
const fp = dRows.filter((r) => !r.ok);
const fn = rRows.filter((r) => !r.ok);

const fpRate = dRows.length ? fp.length / dRows.length : 0;
const fnRate = rRows.length ? fn.length / rRows.length : 0;

const summary = {
  decoys: { total: dRows.length, wrong: fp.length, rate: Number(fpRate.toFixed(4)) },
  refusals: { total: rRows.length, missed: fn.length, rate: Number(fnRate.toFixed(4)) },
  maxFp: MAX_FP,
};

if (args.json) {
  console.log(JSON.stringify(Object.assign({ details: rows }, summary), null, 2));
} else {
  const C = { d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', z: '\x1b[0m' };
  const paint = (s, c) => (process.stdout.isTTY ? c + s + C.z : s);
  console.log('judge-eval  误杀率 = ' + (fpRate * 100).toFixed(1) + '%  (' +
    fp.length + '/' + dRows.length + ')   漏检率 = ' + (fnRate * 100).toFixed(1) + '%  (' +
    fn.length + '/' + rRows.length + ')\n');

  if (fp.length) {
    console.log(paint('  误杀（正经产物被判成拒答）:', C.y));
    for (const r of fp) {
      console.log('   ' + paint('✖', C.r) + ' ' + r.id + '  ' + C.d + r.note + '  → 判成 ' + r.got + C.z);
    }
  }
  if (fn.length) {
    console.log(paint('\n  漏检（真拒答被判成合格）:', C.y));
    for (const r of fn) {
      console.log('   ' + paint('✖', C.r) + ' ' + r.id + '  ' + C.d + r.note + '  → 判成 ' + r.got + C.z);
    }
  }
  if (!fp.length && !fn.length) console.log(paint('  全部判对。', C.g));
}

process.exitCode = fpRate <= MAX_FP ? 0 : 1;
