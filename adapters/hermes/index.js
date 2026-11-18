'use strict';
/**
 * adapters/hermes/index.js —— Hermes Agent adapter（行为与 v2.0 完全一致）
 *
 * 这一层只是把 lib/v2 里原本写死在引擎中的宿主假设搬进来：
 *   AST（宿主 python 符号级）、shim（venv site-packages 的 .pth + 注入脚本）、
 *   文本锚点（lib/patches.js）、L1/L2/L3 验证（py_compile + 行为断言 + 真跑一轮）。
 * 引擎（caps / txn / metrics / bin purge）不认识 python，只调这里。
 */

const path = require('path');
const platform = require('../../lib/v2/platform');
const impls = require('../../lib/v2/impls');
const shim = require('../../lib/v2/shim');
const verify = require('../../lib/v2/verify');
const caps = require('./caps');

/* ───────────── 实现分发 ───────────── */

function probeImpl(impl, capId, ctx) {
  if (!impl) return null;
  if (impl.kind === 'ast') return impls.probeAst(impl, capId, ctx);
  if (impl.kind === 'shim') return impls.probeShim(impl, capId, ctx);
  if (impl.kind === 'text') return impls.probeText(impl.spec, capId, ctx);
  return null;
}

function applyImpl(impl, capId, ctx) {
  if (!impl) return { changed: false, detail: '没有可用实现' };
  if (impl.kind === 'ast') return impls.applyAst(impl, capId, ctx);
  if (impl.kind === 'shim') return impls.applyShim(impl, capId, ctx);
  if (impl.kind === 'text') return impls.applyText(impl.spec, capId, ctx);
  return { changed: false, detail: '未知实现: ' + impl.kind };
}

/** 0.21.0 变体（只有 hermes 有） */
function probeVariant(vspec, capId, ctx) { return impls.probeText(vspec, capId, ctx); }

/* ───────────── shim（venv site-packages） ───────────── */

function collectShim(capList) {
  const entries = [];
  for (const cap of capList) {
    if (!cap.shimMeta) continue;
    entries.push(...caps.shimEntriesFor(cap).map((e) => Object.assign({ cap: cap.id }, e)));
  }
  return entries;
}

/** 事务要覆盖的 shim 文件相对路径 */
function shimRelPaths(target) {
  const out = [];
  for (const sp of platform.sitePackages(target)) {
    out.push(path.relative(target, path.join(sp, shim.SHIM_NAME)));
    out.push(path.relative(target, path.join(sp, shim.PTH_NAME)));
  }
  return out;
}

function installShim(target, entries) { return shim.install(target, entries); }
function uninstallShim(target, opts) { return shim.uninstall(target, opts); }
function readShimLog(target) { return shim.readLog(target); }

/* ───────────── 验证 ───────────── */

function verifyL1(target, files, ctx) {
  return verify.l1Static(target, files, ctx.py);
}
function verifyL2(target, capList, ctx) {
  return verify.l2Runtime(target, capList, ctx.py);
}
function verifyL3(target, opts) {
  return verify.l3E2E(target, opts);
}

module.exports = {
  caps,
  host: { label: 'python', find: (target) => platform.findPython(target) },
  probeImpl, applyImpl, probeVariant,
  collectShim, shimRelPaths, installShim, uninstallShim, readShimLog,
  verifyL1, verifyL2, verifyL3,
};