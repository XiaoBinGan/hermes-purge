'use strict';
/**
 * lib/v2/ast.js —— AST 层（首选实现）
 *
 * 用宿主自己的 python 跑 lib/v2/_ast.py，因此不依赖任何 python 解析库、
 * 也不依赖 Node 侧对 python 语法的理解。
 *
 * Windows 上两个坑（Mac/Linux 遇不到）：
 *   1. 解释器可能是 .bat 代理（pyenv-win / nvm / npm shim），spawnSync 直接跑会
 *      EINVAL —— 必须走 platform.spawnAny；
 *   2. 中文路径 + cp936 控制台会把 JSON 输出打成乱码 —— 子进程强制 UTF-8，
 *      助手那边再 ensure_ascii 兜一层。
 * 失败的 reason 也要说实话：spawn 失败 ≠ 助手输出坏了。
 */

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

const HELPER = path.join(__dirname, '_ast.py');

function runHelper(py, args, opts) {
  const o = opts || {};
  const r = platform.spawnAny(py, [HELPER].concat(args), {
    encoding: 'utf8',
    timeout: o.timeout || 120000,
    env: platform.pyEnv(),
    input: o.input,
  });
  if (r.error) {
    return {
      ok: false,
      reason: 'helper-spawn-failed',
      detail: String(r.error.code || 'ERROR') + ': ' + String(r.error.message || '').split('\n')[0],
      py,
    };
  }
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const out = lines.length ? lines[lines.length - 1].trim() : '';
  if (!out) {
    return {
      ok: false,
      reason: r.status === 0 ? 'helper-empty-output' : 'helper-failed',
      detail: (r.stderr || '').trim().slice(0, 300),
      status: r.status,
      py,
    };
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    return {
      ok: false,
      reason: 'bad-helper-output',
      detail: (out || (r.stderr || '')).slice(0, 300),
      py,
    };
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
  if (!py) return false;
  if (!platform.probePython(py)) return false;
  return fs.existsSync(HELPER);
}

module.exports = { locate, forceReturn, setAssign, available, HELPER, runHelper };
