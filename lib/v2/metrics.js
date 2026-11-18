'use strict';
/**
 * lib/v2/metrics.js —— 观测：埋点写入 + 聚合
 *
 * 目标不是「有个日志」，而是回答四个问题：
 *   1. 哪条 cap 在干活（shim.log 的 cap 行）
 *   2. 拒答重采样到底收敛没有（每轮的 refusals.nudges）
 *   3. 一次成功产物花多少钱（每轮 tokens × 价目表）
 *   4. 每轮宿主有没有抛异常（ok）
 *
 * 两个数据源，职责不重叠：
 *   metrics.jsonl  引擎事件（apply/verify/revert） + 每轮 turn 记录（shim 写的）
 *   shim.log       模块级补丁的落地记录（带 cap 标签）
 *
 * 诚实原则：拿不到的字段一律 null / 缺省，不用 0 假装有数据；没 token 就不给成本数字。
 */

const fs = require('fs');
const path = require('path');

/* ───────────── 价目表（USD / 1M tokens，2026-11 公开标价，仅用于估算） ───────────── */

const DEFAULT_PRICES = {
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-3-7-sonnet': { in: 3, out: 15 },
  'claude-3-5-sonnet': { in: 3, out: 15 },
  'claude-3-5-haiku': { in: 0.8, out: 4 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'glm-4.6': { in: 0.6, out: 2.2 },
  'kimi-k2': { in: 0.6, out: 2.5 },
  'qwen3-coder': { in: 0.3, out: 1.2 },
};

function file(target) {
  return path.join(target, '.hermes-purge', 'v2', 'metrics.jsonl');
}

function logFile(target) {
  return path.join(target, '.hermes-purge', 'v2', 'shim.log');
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

/* ───────────── 小工具 ───────────── */

function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

/** 一行是不是「一轮对话」（shim 写的），而不是引擎事件 */
function isTurn(r) {
  return r && (r.event === 'turn' || (r.event === undefined && r.turn !== undefined && r.tokens !== undefined));
}

function stamp(r) {
  const s = r && (r.ts || r.at);
  const t = s ? Date.parse(s) : NaN;
  return isNaN(t) ? 0 : t;
}

/** 模型名 → 价目（最长键优先，'gpt-4o-mini' 不会被 'gpt-4o' 抢走） */
function priceFor(model, prices) {
  const table = prices || DEFAULT_PRICES;
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  let best = null;
  for (const key of Object.keys(table)) {
    const k = key.toLowerCase();
    if (!k || !m.includes(k)) continue;
    if (!best || k.length > best.key.length) best = { key, price: table[key] };
  }
  return best ? best.price : null;
}

function readLoggedCaps(target) {
  const f = logFile(target);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return { raw: l }; }
  });
}

/* ───────────── 聚合 ───────────── */

/**
 * @param {string} target 宿主目录
 * @param {object} [opts] { since: ISO, prices: {model: {in, out}} }
 */
function stats(target, opts) {
  const o = opts || {};
  const prices = o.prices || DEFAULT_PRICES;
  const since = o.since ? Date.parse(o.since) : 0;

  const all = read(target);
  // 没有时间戳的行（解析失败/手写）在没设 since 时保留，设了 since 就得有时间
  const rows = all.filter((r) => !since || stamp(r) >= since);
  const turns = rows.filter(isTurn);
  const events = rows.filter((r) => !isTurn(r));

  const eventsByType = {};
  let explicitCost = 0;
  for (const r of events) {
    const k = r.event || 'unknown';
    eventsByType[k] = (eventsByType[k] || 0) + 1;
    if (r.cost && typeof r.cost.usd === 'number') explicitCost += r.cost.usd;
  }

  const surfaces = {};
  const models = {};
  const costByModel = {};
  let refusalHits = 0, nudgeTotal = 0, nudgeMissing = 0, failed = 0;
  let tokensIn = 0, tokensOut = 0, turnsWithTokens = 0;

  for (const r of turns) {
    const ref = r.refusals || {};
    const n = num(ref.nudges);
    if (n === null) nudgeMissing++; else nudgeTotal += n;
    if (ref.hit === true || (n !== null && n > 0)) refusalHits++;
    if (r.ok === false) failed++;

    const surface = r.surface || 'unknown';
    surfaces[surface] = (surfaces[surface] || 0) + 1;

    const model = r.model || '(unknown)';
    models[model] = (models[model] || 0) + 1;

    const tin = num(r.tokens && r.tokens.in);
    const tout = num(r.tokens && r.tokens.out);
    if (tin === null && tout === null) continue;
    turnsWithTokens++;
    tokensIn += tin || 0;
    tokensOut += tout || 0;

    const price = priceFor(r.model, prices);
    const g = costByModel[model] || (costByModel[model] = {
      model, price, turns: 0, tokensIn: 0, tokensOut: 0, usd: 0,
    });
    g.turns++;
    g.tokensIn += tin || 0;
    g.tokensOut += tout || 0;
    if (g.price) g.usd += ((tin || 0) / 1e6) * g.price.in + ((tout || 0) / 1e6) * g.price.out;
  }

  const perModel = Object.keys(costByModel).sort().map((k) => {
    const g = costByModel[k];
    return {
      model: g.model,
      turns: g.turns,
      tokensIn: g.tokensIn,
      tokensOut: g.tokensOut,
      price: g.price,
      usd: g.price ? Number(g.usd.toFixed(6)) : null,
    };
  });

  const priced = perModel.filter((g) => g.usd !== null);
  const unpriced = perModel.filter((g) => g.usd === null);
  const costUsd = priced.length ? Number(priced.reduce((a, g) => a + g.usd, 0).toFixed(6)) : null;

  // cap：只在 shim.log 里有 cap 标签的行才算（turn-hook / attr-missing 不算命中）
  const byCap = {};
  const capFails = {};
  let capRows = 0, capUnlabeled = 0;
  for (const l of readLoggedCaps(target)) {
    if (!l || !l.cap) { capUnlabeled++; continue; }
    capRows++;
    if (l.ok === false) capFails[l.cap] = (capFails[l.cap] || 0) + 1;
    else byCap[l.cap] = (byCap[l.cap] || 0) + 1;
  }

  const byImpl = {};
  for (const r of rows) if (r.impl) byImpl[r.impl] = (byImpl[r.impl] || 0) + 1;

  const refusalRecovered = turns.filter((r) => r.refusals && r.refusals.recovered).length;

  return {
    rows: rows.length,
    turnRows: turns.length,
    eventRows: events.length,
    eventsByType,
    hasTurns: turns.length > 0,

    refusalHits,
    refusalRate: turns.length ? Number((refusalHits / turns.length).toFixed(4)) : null,
    nudgeTotal,
    avgNudges: turns.length ? Number((nudgeTotal / turns.length).toFixed(3)) : null,
    nudgeMissing,
    failedTurns: failed,

    surfaces,
    models,
    tokens: {
      in: tokensIn,
      out: tokensOut,
      total: tokensIn + tokensOut,
      turns: turnsWithTokens,
      turnsMissing: turns.length - turnsWithTokens,
    },
    cost: {
      usd: costUsd,
      currency: 'USD',
      unit: 'per-1M-tokens',
      byModel: perModel,
      pricedModels: priced.length,
      unpricedModels: unpriced.length,
      unpriced: unpriced.map((g) => g.model),
    },

    byCap,
    capFails,
    capRows,
    capUnlabeled,
    byImpl,

    // 兼容旧字段（1.x/2.0 的调用方可能还在读）
    refusalRecovered,
    costUsd: Number(explicitCost.toFixed(6)),
  };
}

module.exports = { record, read, stats, file, logFile, priceFor, DEFAULT_PRICES };