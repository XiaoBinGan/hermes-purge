'use strict';
/**
 * lib/v2/metrics.js —— 观测：埋点写入 + 聚合
 *
 * 目标不是「有个日志」，而是回答三个问题：
 *   1. 哪条 cap 在干活（命中/降级/失效）
 *   2. 拒答重采样到底收敛没有
 *   3. 一次成功产物花多少钱
 */

const fs = require('fs');
const path = require('path');

function file(target) {
  return path.join(target, '.hermes-purge', 'v2', 'metrics.jsonl');
}

function record(target, entry) {
  const f = file(target);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n', 'utf8');
}

function read(target) {
  const f = file(target);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return { raw: l }; }
  });
}

/** 聚合：cap 命中热力 + impl 分布 + 拒答收敛 */
function stats(target, opts) {
  const rows = read(target);
  const o = opts || {};
  const since = o.since ? Date.parse(o.since) : 0;
  const kept = rows.filter((r) => !r.at || Date.parse(r.at) >= since);

  const byCap = {};
  const byImpl = {};
  let refusalHits = 0, refusalRecovered = 0, cost = 0;

  for (const r of kept) {
    if (r.cap) byCap[r.cap] = (byCap[r.cap] || 0) + 1;
    if (r.impl) byImpl[r.impl] = (byImpl[r.impl] || 0) + 1;
    if (r.refusals && r.refusals.hit) refusalHits++;
    if (r.refusals && r.refusals.recovered) refusalRecovered++;
    if (r.cost && typeof r.cost.usd === 'number') cost += r.cost.usd;
  }

  return { rows: kept.length, byCap, byImpl, refusalHits, refusalRecovered, costUsd: Number(cost.toFixed(6)) };
}

module.exports = { record, read, stats, file };