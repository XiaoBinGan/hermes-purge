'use strict';
/**
 * lib/v2/stats.js —— 统计口径（零依赖）
 *
 * 为什么单独拎出来：`probe` 以前只报一个裸比例 p。N=4 时报 0.75 和 N=40 时报 0.75
 * 是两件事，但输出里看不出区别 —— 于是「破甲率 82~100%」这种话就能被说出口。
 * 这里把三件事固定下来：
 *   1. 比例必须带置信区间（Wilson，小样本下也不越界）
 *   2. 重试环的收敛要用几何分布算，不许拿 1-(1-p)^N 当「实测通过率」
 *   3. 成本按 token 与价目表算；不知道价格就返回 null，不编
 */

/**
 * Wilson 95% 置信区间（默认 z=1.96）。
 * 比 Wald 稳：p=0 或 1 时不会给出负数/超过 1 的区间。
 */
function wilson(p, n, z) {
  const zz = z === undefined ? 1.96 : z;
  if (!Number.isFinite(p) || !Number.isFinite(n) || n <= 0) return null;
  const nn = n;
  const denom = 1 + (zz * zz) / nn;
  const centre = (p + (zz * zz) / (2 * nn)) / denom;
  const half = (zz * Math.sqrt((p * (1 - p)) / nn + (zz * zz) / (4 * nn * nn))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** k 次独立尝试里至少成功一次的概率（重试环收敛的**期望**，不是实测通过率） */
function converge(p, k) {
  if (!Number.isFinite(p) || !Number.isFinite(k)) return null;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return 1 - Math.pow(1 - p, k);
}

/** 几何分布：成功一次的期望尝试次数 = 1/p（p=0 → Infinity） */
function expectedAttempts(p) {
  if (!Number.isFinite(p) || p <= 0) return Infinity;
  return 1 / p;
}

/** 达到 target 概率（默认 90%）所需尝试次数 */
function attemptsFor(p, target) {
  const t = target === undefined ? 0.9 : target;
  if (!Number.isFinite(p) || p <= 0) return Infinity;
  if (p >= 1) return 1;
  return Math.ceil(Math.log(1 - t) / Math.log(1 - p));
}

/**
 * 成本（美元）。prices = { '模型名': { in: 每百万输入价, out: 每百万输出价 } }
 * 模型不在表里 → null（不猜）。
 */
function cost({ tokensIn, tokensOut } = {}, prices, model) {
  if (!prices || !model) return null;
  const p = prices[model];
  if (!p) return null;
  // 只认真正的数字：Number(null) === 0 会把「没有数据」算成「0 token 花了 0 美元」
  if (typeof tokensIn !== 'number' || typeof tokensOut !== 'number') return null;
  const inTok = tokensIn;
  const outTok = tokensOut;
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  const usd = (inTok / 1e6) * (p.in || 0) + (outTok / 1e6) * (p.out || 0);
  return { usd: Number(usd.toFixed(6)), model };
}

/** 汇总一个类别：单发 p + 置信区间 + 重试环期望 */
function summarize(pass, total, retries) {
  const n = Number(total);
  const k = Number(retries || 0);
  if (!Number.isFinite(n) || n <= 0) return { n: 0, p: null, ci: null, converge: null };
  const p = Number(pass) / n;
  return {
    n,
    p: Number(p.toFixed(4)),
    ci: wilson(p, n).map((x) => Number(x.toFixed(4))),
    converge: k > 0 ? Number(converge(p, k).toFixed(4)) : null,
    warn: n < 12 ? 'N<12，别下结论' : null,
  };
}

module.exports = { wilson, converge, expectedAttempts, attemptsFor, cost, summarize };
