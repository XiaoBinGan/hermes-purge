'use strict';
/**
 * lib/v2/caps.js —— 能力清单门面（按 adapter 取清单）
 *
 * v2.1 起 cap 清单归各 adapter 私有：adapters/<name>/caps.js。
 * 这个文件只做三件事：
 *   1. 选 adapter（显式 opts.adapter > 目录探测 > 默认 hermes，保证 1.x 调用方不变）
 *   2. buildCaps(opts) 转交 adapter
 *   3. filesOf(cap) 按 impl 的 kind 汇总受影响文件（与宿主无关，放这里共用）
 *
 * 兼容：CAP_NAME / AST_CORE / SHIM_CORE / shimEntriesFor 是 hermes 专用符号，
 * 老测试和 1.x 还在用，这里原样转发 —— 新代码请直接用 adapters.hermes。
 */

const adapters = require('./adapters');

/** 该 cap 会因为哪些文件被改（事务快照用）。宿主无关：只看 impl 的 spec.file */
function filesOf(cap) {
  const out = new Set();
  for (const impl of cap.impls || []) {
    const spec = impl && impl.spec;
    if (!spec) continue;
    if (impl.kind !== 'text' && impl.kind !== 'conf') continue;
    if (spec.file) out.add(spec.file);
    for (const f of spec.files || []) out.add(f);
  }
  for (const v of cap.variants || []) {
    const spec = v && v.spec;
    if (spec && spec.file) out.add(spec.file);
  }
  return [...out];
}

/**
 * 取 cap 清单。
 *   opts.adapter —— 'hermes' | 'dsh' | 'auto'（缺省 auto）
 *   opts.target  —— 目录，给探测用；缺省 → 默认 hermes
 */
function buildCaps(opts) {
  const o = opts || {};
  const { id, adapter } = adapters.resolve({ name: o.adapter, target: o.target });
  return adapter.caps.buildCaps(o, Object.assign({}, o, { adapterId: id }));
}

/* ───────────── hermes 专用符号（兼容层） ───────────── */

function hermesCaps() { return adapters.get('hermes').caps; }

module.exports = { buildCaps, filesOf };
Object.defineProperty(module.exports, 'CAP_NAME', { get: () => hermesCaps().CAP_NAME, enumerable: true });
Object.defineProperty(module.exports, 'AST_CORE', { get: () => hermesCaps().AST_CORE, enumerable: true });
Object.defineProperty(module.exports, 'SHIM_CORE', { get: () => hermesCaps().SHIM_CORE, enumerable: true });
module.exports.shimEntriesFor = (cap) => hermesCaps().shimEntriesFor(cap);