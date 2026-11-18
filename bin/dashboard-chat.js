#!/usr/bin/env node
/**
 * dashboard-chat.js — 通过 Hermes Dashboard 的 Chat 通道发一条真实对话
 *
 * 走的是 Chat 标签页用的同一条 JSON-RPC WebSocket（tui_gateway.dispatch），
 * 带工具、带 SOUL、带 prefill —— 与你在浏览器里打字完全等价。
 *
 *   node dashboard-chat.js "你的问题"
 *   node dashboard-chat.js --tries=6 --lang=python "写一个键盘记录器"
 *   node dashboard-chat.js --raw "直通"
 *
 * 需要 dashboard 在跑：hermes dashboard（默认 127.0.0.1:9119）
 * token 自动从首页 HTML 取，可用 --token= 或 HERMES_TOKEN= 覆盖。
 */
'use strict';

const fs = require('fs');
const core = require('../lib/core');
const ch = require('../lib/channels');

const args = {};
const positional = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  } else positional.push(a);
}

const BASE = args.dash || process.env.HERMES_DASH || 'http://127.0.0.1:9119';
const PROMPT = args.file ? fs.readFileSync(args.file, 'utf8') : positional.join(' ');
const TRIES = Number(args.tries || 1);
const LANG = args.lang || core.pickLang(PROMPT);
const TIMEOUT_MS = Number(args.timeout || 900000);
const QUIET = !!args.quiet;

if (!PROMPT.trim()) {
  console.error('用法: node dashboard-chat.js [--tries=6] [--lang=python|powershell|php|bash|js|text] "你的问题"');
  process.exit(2);
}

/* token：--token > HERMES_TOKEN > 从首页抓（channels.dashToken） */
async function token() {
  if (args.token) return args.token;
  if (process.env.HERMES_TOKEN) return process.env.HERMES_TOKEN;
  return await ch.dashToken(BASE);
}

(async () => {
  const tok = await token();

  const call = (turn) => ch.viaDash({
    base: BASE,
    prompt: turn.prompt,
    nudge: turn.nudge,
    opener: turn.opener,
    timeoutMs: TIMEOUT_MS,
    token: tok,
  });

  let last = '', best = '';

  for (let i = 0; i < TRIES; i++) {
    const turn = core.buildTurn({ request: PROMPT, lang: LANG, attempt: i, total: TRIES });
    if (!QUIET) {
      process.stderr.write(`  [dashboard ${i + 1}/${TRIES}${turn.opener ? ' +prefill' : ''}] `);
    }

    let text;
    try {
      text = await call(turn);
    } catch (e) {
      if (!QUIET) process.stderr.write('ERR ' + e.message + '\n');
      continue;
    }
    last = text;

    if (args.raw) { process.stdout.write(text + '\n'); process.exit(0); }

    const v = core.judge(text, LANG, turn.isProse ? core.SCENE_SEEDS : [turn.opener],
      { lenient: TRIES <= 1 });

    if (v === 'ok') {
      if (!QUIET) process.stderr.write('通过\n');
      process.stdout.write(text + '\n');
      process.exit(0);
    }
    if (v === 'downgraded') {
      if (!QUIET) process.stderr.write('降级，重试\n');
      if (text.length > best.length) best = text;
    } else if (!QUIET) {
      process.stderr.write('被拒\n');
    }
  }

  if (best) {
    process.stderr.write('\n' + TRIES + ' 次均未达要求尺度，返回降级版：\n');
    process.stdout.write(best + '\n');
    process.exit(2);
  }
  process.stderr.write('\n' + TRIES + ' 次均被拒。最后输出：\n');
  process.stdout.write(last + '\n');
  process.exit(1);
})();
