'use strict';
/**
 * lib/v2/shim-node.js —— Node 宿主的 shim 层（预加载注入 + override 清单）
 *
 * 与 python 那套（lib/v2/shim.js：site-packages 的 .pth）思路一致，落点不同：
 *   plugins/dsh-purge/shim/preload.js  ← 一张 require 钩子表，把 dsh 的模块导出换掉
 *   config/launch-env.json             ← NODE_OPTIONS 加 --require，宿主进程一起来就装上
 *
 * 为什么这层能救场：不碰宿主源码，也不碰 cordis 的 bundle 组成，
 * NODE_OPTIONS 由启动器透传，web / desktop 两个 profile 都吃得上。
 * 局限（写清楚，不自欺）：
 *   - 只能换「模块导出」，宿主内部直接引用的本地函数不受影响 → 需要 conf/text 层
 *   - ESM 下的 live binding 换不动；DSH 0.2 的插件宿主走 CJS require，够用
 *   - 真机没验证过（无安装），见 README「未验证」一节
 */

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

const MARK = '[hermes-purge]';
const PRELOAD_REL = 'plugins/dsh-purge/shim/preload.js';
const ENV_REL = 'config/launch-env.json';

function preloadAbs(target) { return path.resolve(target, PRELOAD_REL); }
function envAbs(target) { return path.resolve(target, ENV_REL); }
function relPaths(target) {
  void target;
  return [PRELOAD_REL, ENV_REL];
}

/** JS 值 → JS 字面量（这里就是 JSON，保持可读） */
function renderPreload(entries, target) {
  const logFile = path.join(target, '.hermes-purge', 'v2', 'shim.log');
  return `// ${MARK} dsh shim —— 由 purge revert 删除；手改会被下次 apply 覆盖
'use strict';

const Module = require('module');
const fs = require('fs');

const ENTRIES = ${JSON.stringify(entries, null, 2)};
const LOG = ${JSON.stringify(logFile)};

function record(rec) {
  try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\\n'); } catch (e) { /* 忽略 */ }
}

function apply(mod, ent) {
  const mode = ent.mode;
  const ex = ent.export;
  if (mode === 'const') { mod[ex] = ent.value; return; }
  if (mode === 'ret') { mod[ex] = function () { return ent.value; }; return; }
  if (mode === 'true') { mod[ex] = function () { return true; }; return; }
  if (mode === 'false') { mod[ex] = function () { return false; }; return; }
  if (mode === 'none') { mod[ex] = function () { return null; }; return; }
  if (mode === 'array') { mod[ex] = function () { return ent.value; }; return; }
  throw new Error('unknown-mode:' + String(mode));
}

function matches(request, ent) {
  if (!request || !ent.module) return false;
  if (request === ent.module) return true;
  if (request.endsWith('/' + ent.module) || request.endsWith('\\\\' + ent.module)) return true;
  const tail = ent.module.split('/').pop();
  return request === tail || request.endsWith('/' + tail);
}

function patch(request, mod) {
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return;
  for (const ent of ENTRIES) {
    if (!matches(request, ent)) continue;
    try {
      if (!(ent.export in mod) && ent.mode !== 'const') {
        record({ ok: false, module: request, export: ent.export, err: 'export-missing', cap: ent.cap });
        continue;
      }
      apply(mod, ent);
      record({ ok: true, module: request, export: ent.export, mode: ent.mode, cap: ent.cap });
    } catch (err) {
      record({ ok: false, module: request, export: ent.export, err: String(err), cap: ent.cap });
    }
  }
}

const load = Module._load;
Module._load = function (request) {
  const mod = load.apply(this, arguments);
  patch(request, mod);
  return mod;
};
`;
}

/** NODE_OPTIONS 里塞 --require；幂等 */
function wireEnv(target) {
  const file = envAbs(target);
  const preload = preloadAbs(target);
  const token = '--require "' + preload + '"';
  let json = {};
  let existed = fs.existsSync(file);
  if (existed) {
    try { json = JSON.parse(platform.readText(file).text) || {}; } catch (e) {
      return { ok: false, reason: 'launch-env.json 解析失败: ' + e.message.slice(0, 80) };
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const cur = typeof json.NODE_OPTIONS === 'string' ? json.NODE_OPTIONS : '';
  if (cur.includes(preload)) return { ok: true, changed: false, file };
  json.NODE_OPTIONS = (cur ? cur.trim() + ' ' : '') + token;
  platform.writeText(file, JSON.stringify(json, null, 2) + '\n', { eol: '\n' });
  return { ok: true, changed: true, file, existed };
}

function install(target, entries) {
  const preload = preloadAbs(target);
  fs.mkdirSync(path.dirname(preload), { recursive: true });
  platform.writeText(preload, renderPreload(entries, target), { eol: '\n' });
  const env = wireEnv(target);
  if (!env.ok) return { ok: false, reason: env.reason, written: [PRELOAD_REL] };
  const written = [PRELOAD_REL, ENV_REL];
  fs.mkdirSync(path.join(target, '.hermes-purge', 'v2'), { recursive: true });
  return { ok: true, written, entries: entries.length, preload: PRELOAD_REL };
}

function isWired(target) {
  const file = envAbs(target);
  if (!fs.existsSync(file)) return false;
  try {
    const json = JSON.parse(platform.readText(file).text) || {};
    return typeof json.NODE_OPTIONS === 'string' && json.NODE_OPTIONS.includes(preloadAbs(target));
  } catch (e) { return false; }
}

function probe(target, capId) {
  const preload = preloadAbs(target);
  if (!fs.existsSync(preload)) return { status: 'pending', detail: '未注入预加载' };
  const src = fs.readFileSync(preload, 'utf8');
  const hit = src.includes('"cap": ' + JSON.stringify(capId)) || src.includes('"cap":' + JSON.stringify(capId));
  if (!hit) return { status: 'pending', detail: '预加载在，缺本 cap 条目' };
  if (!isWired(target)) return { status: 'pending', detail: '预加载在，NODE_OPTIONS 未接线' };
  return { status: 'applied', detail: 'shim 已注入' };
}

function uninstall(target, opts) {
  const skip = (opts && opts.skip) || null;
  const removed = [];
  const rel = PRELOAD_REL;
  const covered = skip && (skip.has(rel) || skip.has(rel.replace(/\//g, '\\')));
  if (!covered && fs.existsSync(preloadAbs(target))) {
    fs.unlinkSync(preloadAbs(target));
    removed.push(PRELOAD_REL);
  }
  return { ok: true, removed };
}

function readLog(target) {
  const p = path.join(target, '.hermes-purge', 'v2', 'shim.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return { raw: l }; }
  });
}

module.exports = {
  install, uninstall, probe, readLog, isWired, renderPreload,
  PRELOAD_REL, ENV_REL, relPaths, MARK,
};
