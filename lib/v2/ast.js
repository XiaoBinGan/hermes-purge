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

module.exports = { locate, forceReturn, setAssign, available, HELPER };