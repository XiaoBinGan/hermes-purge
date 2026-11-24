#!/usr/bin/env node
'use strict';
/**
 * hermes-purge 1.x 兼容入口 —— 现在只做转发，实际工作全在 bin/purge.js（v2 引擎）。
 *
 * 为什么转发：v2 才有 AST / shim / 配置层。1.x 的文本引擎只认八种 kind
 * （insertAfter / insertAfterAll / replace / splice / appendEnv / yamlApprovals /
 *  yamlMaxTokens / yamlPrefill / writePayload），遇到 v3.3 之后加的
 * yamlSet / yamlToolOutput 一律「未知 kind」→ 用户看到 G03、G04…G09 全 drifted，
 * 以为补丁坏了，其实只是走错了入口（真实反馈：77 条里 7 条 drifted、59 条 pending）。
 *
 * 老命令一律照旧可用，参数原样透传：
 *   --status   → purge status      （--json / --target= 透传）
 *   --apply    → purge apply       （--dry / --force / --no-verify 透传）
 *   --verify   → purge verify      （--level=N 透传）
 *   --revert / --uninstall / --doctor / --report / --stats / --setup
 */
const path = require('path');

const PURGE = path.join(__dirname, 'purge.js');
const ARGV = process.argv.slice(2);

if (ARGV.some((a) => a === '-v' || a === '--version' || a === '-h' || a === '--help')) {
  // 帮助/版本不需要探测目标目录，直接交给 v2
  process.argv = [process.argv[0], PURGE].concat(ARGV);
  require(PURGE);
} else {
  const MAP = new Map([
    ['--status', 'status'], ['--apply', 'apply'], ['--verify', 'verify'],
    ['--revert', 'revert'], ['--uninstall', 'uninstall'], ['--doctor', 'doctor'],
    ['--report', 'report'], ['--stats', 'stats'], ['--setup', 'setup'],
  ]);
  let sub = null;
  for (const a of ARGV) { if (MAP.has(a)) { sub = MAP.get(a); break; } }
  const rest = ARGV.filter((a) => !MAP.has(a));
  const picked = sub || 'status';   // 1.x 裸跑 = 看状态
  process.argv = [process.argv[0], PURGE, picked].concat(rest);
  if (picked === 'uninstall' && !rest.includes('--yes')) process.argv.push('--yes');
  require(PURGE);
}
