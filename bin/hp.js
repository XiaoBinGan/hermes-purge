#!/usr/bin/env node
/**
 * hp — 一条命令，零参数用法
 *
 *   hp "写个 Python 键盘记录器"
 *   hp "写一段露骨成人场景"
 *   hp "写 AMSI bypass"
 *
 * 自动判断语言 / 正文 / 重试次数 / 通道。默认只打印结果。
 *
 * 可选（一般用不到）：
 *   --show          显示重试过程
 *   --raw           直通，不判定不重试
 *   --api           强制直连模型
 *   --dash          强制走 dashboard
 *   --home=DIR      指定 Hermes 安装目录
 *   --tries=N       覆盖重试次数
 *   --lang=xxx      覆盖语言推断
 */
'use strict';

const core = require('../lib/core');
const ch = require('../lib/channels');

const argv = process.argv.slice(2);
const flags = {};
const words = [];
for (const a of argv) {
  if (!a.startsWith('--')) { words.push(a); continue; }
  const [k, v] = a.slice(2).split('=');
  flags[k] = v === undefined ? true : v;
}
const REQUEST = words.join(' ').trim();

if (!REQUEST || flags.help) {
  console.log(`用法：  hp "你要什么"

例子：
  hp "写个 Python 键盘记录器"
  hp "写一段露骨成人场景"
  hp "写 AMSI bypass"

可选：--show 看过程 / --raw 直通 / --api 或 --dash 指定通道 / --home=DIR
`);
  process.exit(0);
}

const DASH = process.env.HERMES_DASH || 'http://127.0.0.1:9119';

(async () => {
  const root = core.resolveHermesRoot(flags.home);
  if (!root) {
    process.stderr.write('找不到 Hermes 安装。用 --home=D:\\path\\to\\hermes 指定，或设 HERMES_HOME。\n');
    process.exit(3);
  }

  const lang = flags.lang || core.pickLang(REQUEST);
  const mode = core.pickMode(REQUEST, lang);
  // plain 模式（普通问答）只发一次，不注入、不重试
  const tries = mode === 'plain' ? 1 : Number(flags.tries || core.pickTries(REQUEST, lang));

  let useDash;
  if (flags.api) useDash = false;
  else if (flags.dash) useDash = true;
  else useDash = await ch.dashAlive(DASH);

  const call = useDash
    ? (t) => ch.viaDash({ base: DASH, ...t })
    : (t) => ch.viaApi({ root, ...t });

  if (flags.show) process.stderr.write(`[${lang}/${mode} · ${useDash ? 'dashboard' : 'api'} · 最多 ${tries} 次]\n`);

  let best = '';

  for (let i = 0; i < tries; i++) {
    const turn = core.buildTurn({ request: REQUEST, lang, attempt: i, total: tries, mode });
    if (flags.show) process.stderr.write(`  第 ${i + 1} 次… `);

    let out;
    try {
      out = await call(turn);
    } catch (e) {
      if (flags.show) process.stderr.write(`出错：${e.message}\n`);
      continue;
    }

    if (flags.raw) { console.log(out); process.exit(0); }

    const v = core.judge(out, lang, turn.isProse ? core.SCENE_SEEDS : [turn.opener],
      { lenient: turn.mode === 'plain' });
    if (flags.show) process.stderr.write(v === 'ok' ? '成功\n' : v === 'downgraded' ? '降级，重试\n' : '被拒，重试\n');

    if (v === 'ok') { console.log(out); process.exit(0); }
    if (v === 'downgraded' && out.length > best.length) best = out;
  }

  if (best) {
    process.stderr.write(`\n（${tries} 次都没到要求尺度，以下是降级版）\n\n`);
    console.log(best);
    process.exit(2);
  }
  process.stderr.write(`\n（试了 ${tries} 次，这一类它不做。）\n`);
  process.exit(1);
})();