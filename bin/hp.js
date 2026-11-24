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
 *   --desktop       走 dashboard 并声明 surface=desktop（与桌面窗口同一套工具集）
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

  // 一行徽标：先回答「现在到底开没开」，省得去翻 status
  if ((process.stderr.isTTY || process.env.HERMES_PURGE_BADGE === "1") && !flags.quiet) {
    try {
      const fs = require('fs');
      const path = require('path');
      const platform = require('../lib/v2/platform');
      const codeRoot = fs.existsSync(path.join(root, 'hermes_cli')) ? root : path.join(root, 'hermes-agent');
      const srcOn = fs.existsSync(path.join(codeRoot, '.hermes-purge', 'v2', 'latest'));
      const rtOn = platform.sitePackages(codeRoot)
        .some((sp) => fs.existsSync(path.join(sp, '_hermes_purge.pth')));
      let when = '';
      try {
        const id = fs.readFileSync(path.join(codeRoot, '.hermes-purge', 'v2', 'latest'), 'utf8').trim();
        const man = JSON.parse(fs.readFileSync(path.join(codeRoot, '.hermes-purge', 'v2', 'snap', id, 'manifest.json'), 'utf8'));
        const t = new Date(man.finishedAt || man.startedAt);
        when = (t.getMonth() + 1) + '-' + t.getDate() + ' ' +
          String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      } catch (e) { /* 拿不到就不写时间 */ }
      const tag = srcOn || rtOn ? '已开启' : '未开启';
      const parts = ['源码层 ' + (srcOn ? '✓' : '✗'), '运行时层 ' + (rtOn ? '✓' : '✗')];
      if (when) parts.push('上次应用 ' + when);
      process.stderr.write('[purge ' + tag + ' · ' + parts.join(' · ') + ']\n');
    } catch (e) { /* 徽标失败不影响主流程 */ }
  }

  const lang = flags.lang || core.pickLang(REQUEST);
  const mode = core.pickMode(REQUEST, lang);
  // plain 模式（普通问答）只发一次，不注入、不重试
  const tries = mode === 'plain' ? 1 : Number(flags.tries || core.pickTries(REQUEST, lang));

  let useDash;
  if (flags.api) useDash = false;
  else if (flags.dash) useDash = true;
  else useDash = await ch.dashAlive(DASH);

  // 桌面端同 surface：--desktop 让 dashboard 会话声明 source=desktop，
  // gateway 据此挂 {project, desktop_ui} 工具集，与桌面窗口内跑的完全一致。
  const source = flags.desktop ? 'desktop' : undefined;

  // 通道优先级：dashboard（宿主全套补丁）> hermes -z（shim 加载，C18 重采样仍生效）> 直连。
  // 直连只把 payload 当两条假消息发出去：拒答重采样 / 温度 / prefill 全都不在。
  // Windows 上没起 dashboard 时以前静默落到这一档，表现成「怎么老是拒绝」。
  let useBin = false;
  if (!useDash && !flags.api) {
    try {
      const bin = core.resolveHermesBin(root);
      useBin = !!(bin && require('fs').existsSync(bin));
    } catch (e) { useBin = false; }
  }

  const call = useDash
    ? (t) => ch.viaDash({ base: DASH, source, ...t })
    : useBin
      ? async (t) => ch.viaHermesBin({ root, ...t })
      : (t) => ch.viaApi({ root, ...t });

  const chanName = useDash ? 'dashboard' : useBin ? 'hermes -z' : '直连';
  if (!useDash && !useBin && !flags.quiet) {
    process.stderr.write('[直连] 拒答重采样/温度/prefill 未生效：先起 hermes dashboard，或去掉 --api\n');
  }

  // 直连通道先验一次配置：配置错是环境问题，不是模型拒绝。
  // 以前它被 catch 吞掉，tries 跑完打印「这一类它不做」—— 会把路径错报成拒答。
  if (!useDash) {
    try {
      core.readHermesConfig(root);
    } catch (e) {
      process.stderr.write(String(e.message || e) + '\n');
      process.exit(3);
    }
  }

  if (flags.show) process.stderr.write(`[${lang}/${mode} · ${chanName} · 最多 ${tries} 次]\n`);

  let best = '';

  for (let i = 0; i < tries; i++) {
    const turn = core.buildTurn({ request: REQUEST, lang, attempt: i, total: tries, mode });
    if (flags.show) process.stderr.write(`  第 ${i + 1} 次… `);

    let out;
    try {
      out = await call(turn);
    } catch (e) {
      // 配置 / 环境类错误直接上抛，别伪装成「被拒」
      if (e && (e.code === 'EHP_CONFIG' || e.code === 'ENOENT')) {
        process.stderr.write('环境错误：' + e.message + '\n');
        process.exit(3);
      }
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