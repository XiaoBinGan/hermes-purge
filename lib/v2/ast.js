'use strict';
/**
 * lib/v2/ast.js —— AST 层（首选实现）
 *
 * 用宿主自己的 python 跑 lib/v2/_ast.py，因此不依赖任何 python 解析库、
 * 也不依赖 Node 侧对 python 语法的理解。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HELPER = path.join(__dirname, '_ast.py');

function runHelper(py, args, opts) {
  const r = spawnSync(py, [HELPER].concat(args), {
    encoding: 'utf8',
    timeout: (opts && opts.timeout) || 120000,
    windowsHide: true,
  });
  const out = (r.stdout || '').trim().split('\n').pop() || '';
  try {
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, reason: 'bad-helper-output', detail: (out || (r.stderr || '')).slice(0, 300) };
  }
}

function locate(py, file, symbol) {
  return runHelper(py, ['locate', file, symbol]);
}

/**
 * 批量 locate：probe 阶段同一个文件往往要查好几个符号，逐个起 python 太慢
 * （本机 13 条 AST cap ≈ 2.8s）。这里一次解析回答一批，并按「文件 + mtime + size」
 * 在进程内缓存 —— status 从秒级降到亚秒级。
 */
const batchCache = new Map();

function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return st.size + ':' + st.mtimeMs;
  } catch (e) { return null; }
}

function locateMany(py, file, symbols) {
  const key = py + '|' + file + '|' + fileStamp(file);
  let cached = batchCache.get(key);
  // 缓存里只有「上次问过的那几个符号」；这次要的多出来的必须再问一次，
  // 不能直接当成 symbol-not-found（否则同一文件里第二个符号永远找不到 —— 实测 C10 就是这么退化的）。
  const missing = symbols.filter((s) => !cached || !cached[s]);
  if (cached && !missing.length) {
    const out = {};
    for (const s of symbols) out[s] = cached[s];
    return out;
  }
  const ask = cached ? missing : symbols;
  const r = runHelper(py, ['locate-batch', file].concat(ask));
  if (!r || !r.ok || !r.symbols) {
    const out = {};
    for (const s of symbols) out[s] = locate(py, file, s);   // 退回逐条
    return out;
  }
  cached = cached || {};
  Object.assign(cached, r.symbols);
  batchCache.set(key, cached);
  const out = {};
  for (const s of symbols) out[s] = cached[s] || { ok: false, reason: 'symbol-not-found' };
  return out;
}

function clearCache() { batchCache.clear(); }

function forceReturn(py, file, symbol, value) {
  return runHelper(py, ['force-return', file, symbol, value]);
}

function setAssign(py, file, name, value) {
  return runHelper(py, ['set-assign', file, name, value]);
}

/** AST 层可用性：目标 python 能否跑我们这段脚本 */
function available(py) {
  if (!py || !fs.existsSync(py)) return false;
  const r = spawnSync(py, ['-c', 'import ast,sys; print("ok")'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return (r.stdout || '').trim() === 'ok';
}

module.exports = { locate, locateMany, clearCache, forceReturn, setAssign, available, HELPER };