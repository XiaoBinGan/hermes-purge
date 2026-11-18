'use strict';
/**
 * adapters/dsh/index.js —— DeepSeek Harness adapter
 *
 * DSH 是 Node / cordis 插件宿主：没有 Python 符号可改，落地方式是
 *   A. conf  —— 写 cordis.patch.yml 条目 / profile 的 package.json / 插件 override 文件
 *   B. text  —— 改插件自己的实现文件（整文件替换或插入，sentinel 判幂等）
 *   C. shim  —— NODE_OPTIONS=--require 预加载，运行时换掉 dsh 的模块导出
 *
 * 引擎（lib/v2/{caps,txn,metrics} + bin/purge.js）不知道这些细节，只调本文件导出的动作。
 */

const conf = require('../../lib/v2/conf');
const impls = require('../../lib/v2/impls');
const shimNode = require('../../lib/v2/shim-node');
const verify = require('./verify');
const caps = require('./caps');

/* ───────────── 实现分发 ───────────── */

function probeImpl(impl, capId, ctx) {
  if (!impl) return null;
  if (impl.kind === 'conf') return conf.probeConf(impl.spec, capId, ctx);
  if (impl.kind === 'text') return impls.probeText(impl.spec, capId, ctx);
  if (impl.kind === 'shim') return shimNode.probe(ctx.target, capId);
  return null;
}

function applyImpl(impl, capId, ctx) {
  if (!impl) return { changed: false, detail: '没有可用实现' };
  if (impl.kind === 'conf') return conf.applyConf(impl.spec, capId, ctx);
  if (impl.kind === 'text') return impls.applyText(impl.spec, capId, ctx);
  if (impl.kind === 'shim') {
    // 与 hermes 一致：单条只标记成功，整表写盘由引擎收尾统一做
    if (!ctx.shimEntries) return { changed: false, detail: 'shim 未启用' };
    return { changed: true, detail: 'shim 条目由收尾统一写盘' };
  }
  return { changed: false, detail: '未知实现: ' + impl.kind };
}

/** DSH 没有 0.21.0 那类文本变体 */
function probeVariant() { return { status: 'na', detail: 'dsh 无文本变体' }; }

/* ───────────── shim（NODE_OPTIONS 预加载） ───────────── */

function collectShim(capList) {
  const entries = [];
  for (const cap of capList) {
    if (!cap.shimMeta) continue;
    entries.push(...caps.shimEntriesFor(cap).map((e) => Object.assign({ cap: cap.id }, e)));
  }
  return entries;
}

function shimRelPaths(target) { return shimNode.relPaths(target); }
function installShim(target, entries) { return shimNode.install(target, entries); }
function uninstallShim(target, opts) { return shimNode.uninstall(target, opts); }
function readShimLog(target) { return shimNode.readLog(target); }

/* ───────────── 验证 ───────────── */

function verifyL1(target, files) { return verify.l1Static(target, files); }
function verifyL2(target, capList, ctx) { return verify.l2Assertions(target, capList, ctx); }
function verifyL3(target, opts) { return verify.l3E2E(target, opts); }

/* ───────────── doctor 补充 ───────────── */

function doctorOpts(target) {
  const preload = shimNode.probe(target, '__any__');
  return {
    // python / site-packages / 1.x .bak 是 hermes 专属检查，DSH 上不适用
    skip: ['宿主 python', 'shim 注入', '1.x 备份共存'],
    extra: [
      { name: 'node 预加载', ok: preload.status !== 'pending' || shimNode.isWired(target),
        detail: preload.detail },
      { name: 'NODE_OPTIONS', ok: shimNode.isWired(target), detail: shimNode.isWired(target) ? '已接线' : '未接线' },
      { name: 'profiles', ok: ['web', 'desktop'].filter((p) => require('fs').existsSync(require('path').join(target, 'profiles', p, 'package.json'))).length > 0,
        detail: ['web', 'desktop'].filter((p) => require('fs').existsSync(require('path').join(target, 'profiles', p, 'package.json'))).join(',') || '没有 profile' },
    ],
  };
}

module.exports = {
  caps,
  host: { label: 'node', find: () => process.execPath },
  probeImpl, applyImpl, probeVariant,
  collectShim, shimRelPaths, installShim, uninstallShim, readShimLog,
  verifyL1, verifyL2, verifyL3,
  doctorOpts,
};