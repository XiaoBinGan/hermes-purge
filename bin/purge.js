#!/usr/bin/env node
'use strict';
/**
 * purge —— hermes-purge v2 引擎（capability layer）
 *
 *   purge status  [--json] [--target=DIR]
 *   purge apply   [--dry] [--no-verify] [--target=DIR]
 *   purge verify  [--level=1|2|3] [--target=DIR]
 *   purge revert  [--force] [--id=SNAP] [--target=DIR]
 *   purge doctor  [--target=DIR]
 *   purge stats   [--json] [--since=ISO] [--target=DIR]
 *   purge --help|-h / --version|-v
 *
 * 与 1.x（bin/hermes-purge.js）共用 lib/patches.js 的锚点清单，但落地方式不同：
 *   AST（符号级）→ shim（运行时）→ 文本（兼容层）→ 配置
 * 所有写操作走事务：快照 → 原子写 → manifest 双哈希 → 可证明回滚。
 */

const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const platform = require('../lib/v2/platform');
const txn = require('../lib/v2/txn');
const shim = require('../lib/v2/shim');
const impls = require('../lib/v2/impls');
const verify = require('../lib/v2/verify');
const metrics = require('../lib/v2/metrics');
const capsLib = require('../lib/v2/caps');

/* ───────────── 参数 ───────────── */

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv.slice(2)) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    out[k] = v === undefined ? true : v;
  }
  return out;
}

const args = parseArgs(process.argv);
const C = { reset: '\x1b[0m', dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m' };
const paint = (s, code) => (process.stdout.isTTY ? code + s + C.reset : s);

/* ───────────── help / version ─────────────
 * 这两个必须优先于目标目录探测：--version / --help 在没装 Hermes 的机器上也要能跑
 * （npm pack 之后的端到端自检就是靠这一点）。
 */

function usageText() {
  return [
    'purge —— hermes-purge v2（capability layer）',
    '',
    '  purge status [--json]        每条 cap 当前走哪层实现',
    '  purge apply  [--dry]         事务式应用（快照 → 写 → 校验）',
    '  purge verify [--level=1|2|3] 静态 / 运行时 / 端到端',
    '  purge revert [--force]       按 manifest 逐字节还原',
    '  purge doctor                 体检：哈希漂移 / 临时文件 / shim',
    '  purge stats [--json] [--since=ISO]  观测：轮次、拒答收敛、cap 命中、成本',
    '',
    '  --target=DIR   指定 Hermes 代码根（默认自动探测或 HERMES_HOME）',
    '',
    '  -h, --help     显示本帮助',
    '  -v, --version  显示版本号',
  ].join('\n');
}

function pkgVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    return JSON.parse(raw).version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

const sub = args._[0];
const wantsHelp = args.help === true || args.h === true || sub === 'help' || sub === '-h' || sub === '--help';
const wantsVersion = args.version === true || args.v === true || sub === 'version' || sub === '-v' || sub === '--version';

// 顶层 return 在 CJS 里合法：直接把模块收尾，stdout 由运行时正常 flush
if (wantsHelp) { console.log(usageText()); return; }
if (wantsVersion) { console.log(pkgVersion()); return; }

function resolveTarget() {
  if (args.target) return path.resolve(args.target);
  const r = core.resolveHermesRoot(args.home);
  if (!r) return null;
  return fs.existsSync(path.join(r, 'hermes_cli')) ? r : path.join(r, 'hermes-agent');
}

const TARGET = resolveTarget();
if (!TARGET || !fs.existsSync(TARGET)) {
  console.error('找不到 Hermes 安装目录。用 --target=DIR 指定，或设 HERMES_HOME。');
  process.exit(3);
}

const py = platform.findPython(TARGET);
const CAPS = capsLib.buildCaps();
const ctx = { target: TARGET, py, shimEntries: [] };

/* ───────────── 实现选择 ───────────── */

function probeChain(cap) {
  const tried = [];
  const only = args.impl ? String(args.impl) : null;
  for (const impl of cap.impls) {
    if (only && impl.kind !== only) continue;
    let st = null;
    if (impl.kind === 'ast') st = impls.probeAst(impl.sites ? impl : impl, cap.id, ctx);
    else if (impl.kind === 'shim') st = impls.probeShim(impl, cap.id, ctx);
    else if (impl.kind === 'text') st = impls.probeText(impl.spec, cap.id, ctx);

    if (st && (st.status === 'applied' || st.status === 'pending')) {
      return { impl, status: st.status, detail: st.detail, kind: impl.kind, tried };
    }
    tried.push(impl.kind + ':' + (st ? st.status : 'n/a'));

    // 文本层失败时试 0.21.0 变体
    if (impl.kind === 'text' && cap.variants && cap.variants.length) {
      for (const v of cap.variants) {
        const vs = impls.probeText(v.spec, cap.id, ctx);
        if (vs.status === 'applied' || vs.status === 'pending') {
          return { impl: { kind: 'text', spec: v.spec }, status: vs.status, detail: vs.detail, kind: 'text', tried, variant: true };
        }
        tried.push('variant:' + vs.status);
      }
    }
  }
  return { impl: null, status: 'drifted', detail: '所有实现都不可用', kind: null, tried };
}

/* ───────────── status ───────────── */

function cmdStatus() {
  const rows = CAPS.map((cap) => {
    const r = probeChain(cap);
    return { id: cap.id, cap: cap.cap, layer: cap.layer, impl: r.kind, status: r.status, detail: r.detail, tried: r.tried };
  });
  if (args.json) { console.log(JSON.stringify({ target: TARGET, python: py, rows }, null, 2)); return; }

  const by = (s) => rows.filter((r) => r.status === s).length;
  console.log(C.b + 'purge v2' + C.reset + '  target=' + TARGET);
  console.log('python=' + (py || '(无)') + '  ·  caps ' + rows.length + '  ·  ' +
    paint('applied ' + by('applied'), C.g) + '  ' + paint('pending ' + by('pending'), C.y) + '  ' +
    paint('drifted ' + by('drifted'), C.r) + '\n');

  let last = '';
  for (const r of rows) {
    if (r.layer !== last) { console.log('  ' + C.c + '── ' + r.layer + ' ──' + C.reset); last = r.layer; }
    const tag = r.status === 'applied' ? paint('✔ applied', C.g)
      : r.status === 'pending' ? paint('· pending', C.y) : paint('✖ ' + r.status, C.r);
    const impl = r.impl ? paint('[' + r.impl + ']', C.c) : paint('[--]', C.dim);
    console.log('  ' + String(r.id).padEnd(5) + tag.padEnd(20) + impl.padEnd(14) + ' ' + C.dim + r.cap + C.reset);
  }
  const ready = by('pending') === 0 && by('drifted') === 0;
  console.log('\n' + (ready ? paint('全部生效', C.g) : paint('有未生效项 —— purge apply', C.y)));
  if (!ready) process.exitCode = 1;
}

/* ───────────── apply ───────────── */

function shimRelPaths() {
  const out = [];
  for (const sp of platform.sitePackages(TARGET)) {
    out.push(path.relative(TARGET, path.join(sp, shim.SHIM_NAME)));
    out.push(path.relative(TARGET, path.join(sp, shim.PTH_NAME)));
  }
  return out;
}

function cmdApply() {
  const dry = !!args.dry;
  const rels = new Set();
  for (const cap of CAPS) for (const f of capsLib.filesOf(cap)) rels.add(f);
  if (!dry) for (const r of shimRelPaths()) rels.add(r);

  console.log(C.b + (dry ? '[dry] 预演' : '应用') + C.reset + ' → ' + TARGET);
  console.log(C.dim + '事务文件 ' + rels.size + ' 个；python=' + (py || '(无)') + C.reset + '\n');

  const snap = dry ? null : txn.begin(TARGET, [...rels]);
  let changed = 0, skipped = 0, failed = 0;

  try {
    for (const cap of CAPS) {
      let r = probeChain(cap);
      if (r.status === 'applied') {
        skipped++;
        console.log('  ' + paint('=', C.dim) + ' ' + cap.id + ' ' + paint(r.kind, C.c) + ' 已生效');
        continue;
      }
      if (r.status !== 'pending') {
        failed++;
        console.log('  ' + paint('✖', C.r) + ' ' + cap.id + ' ' + r.detail + C.dim + '  试过: ' + r.tried.join(' > ') + C.reset);
        continue;
      }
      if (dry) {
        changed++;
        console.log('  ' + paint('·', C.y) + ' ' + cap.id + ' ' + paint(r.kind, C.c) + ' ' + r.detail);
        continue;
      }

      let done = false;
      // 首选实现
      if (r.kind === 'ast') {
        const res = impls.applyAst(r.impl, cap.id, ctx);
        if (res.changed) { done = true; console.log('  ' + paint('✔', C.g) + ' ' + cap.id + ' ' + paint('ast', C.c) + ' ' + res.detail); }
      } else if (r.kind === 'shim') {
        const res = impls.applyShim(r.impl, cap.id, ctx);
        if (res.changed) { done = true; console.log('  ' + paint('✔', C.g) + ' ' + cap.id + ' ' + paint('shim', C.c) + ' ' + res.detail); }
      } else {
        const res = impls.applyText(r.impl.spec, cap.id, ctx);
        done = res.changed;
        console.log('  ' + (done ? paint('✔', C.g) : paint('·', C.y)) + ' ' + cap.id + ' ' + paint('text', C.c) + ' ' + res.detail);
      }

      // 首选失败 → 降级到后面的实现（AST 挂了就写文本）
      if (!done) {
        const idx = cap.impls.findIndex((i) => i === r.impl);
        for (let i = idx + 1; i < cap.impls.length; i++) {
          const impl = cap.impls[i];
          if (impl.kind === 'text') {
            let spec = impl.spec;
            let st = impls.probeText(spec, cap.id, ctx);
            if (st.status !== 'pending' && st.status !== 'applied' && cap.variants) {
              for (const v of cap.variants) {
                const vs = impls.probeText(v.spec, cap.id, ctx);
                if (vs.status === 'pending' || vs.status === 'applied') { spec = v.spec; st = vs; break; }
              }
            }
            const res = impls.applyText(spec, cap.id, ctx);
            if (res.changed) { done = true; console.log('  ' + paint('✔', C.g) + ' ' + cap.id + ' ' + paint('text(fallback)', C.c) + ' ' + res.detail); break; }
          }
        }
      }

      if (done) changed++; else { failed++; console.log('  ' + paint('✖', C.r) + ' ' + cap.id + ' 降级后仍未落地'); }
    }

    // shim 收尾：整表写入（只写一遍）
    if (!dry) {
      ctx.shimEntries = [];
      for (const cap of CAPS) {
        if (!cap.shimMeta) continue;
        ctx.shimEntries.push(...capsLib.shimEntriesFor(cap).map((e) => Object.assign({ cap: cap.id }, e)));
      }
      if (ctx.shimEntries.length) {
        const res = shim.install(TARGET, ctx.shimEntries);
        console.log('\n  ' + (res.ok ? paint('✔', C.g) : paint('✖', C.r)) + ' shim ' +
          (res.ok ? res.entries + ' 条 · ' + res.written.length + ' 个文件' : res.reason));
      }
    }
  } catch (e) {
    if (snap) {
      const n = txn.abort(snap);
      console.error('\n' + paint('apply 异常，已回滚 ' + n + ' 个文件：', C.r) + e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  if (!dry && snap) {
    txn.commit(snap, { caps: CAPS.length });
    metrics.record(TARGET, { event: 'apply', changed, skipped, failed, shim: ctx.shimEntries.length });
    console.log('\n改写 ' + changed + ' · 跳过 ' + skipped + ' · 未命中 ' + failed);
    if (!args['no-verify']) {
      const l1 = verify.l1Static(TARGET, [...rels], py);
      // 文件不在事务里也能编译的（venv 里没有 .py 进 rels 的，跳过）
      const bad = l1.checks.filter((c) => !c.ok);
      console.log(bad.length ? paint('L1 静态检查有 ' + bad.length + ' 项失败', C.r) : paint('L1 静态检查通过', C.g));
      for (const b of bad.slice(0, 5)) console.log('  ' + paint('✖', C.r) + ' ' + b.name + ' ' + b.detail);
    }
    console.log('\n回滚：purge revert   体检：purge doctor');
  } else if (dry) {
    console.log('\n（预演，未写盘）' + changed + ' 条可落');
  }
}

/* ───────────── verify ───────────── */

function cmdVerify() {
  const level = Number(args.level || 2);
  const rels = new Set();
  for (const cap of CAPS) for (const f of capsLib.filesOf(cap)) rels.add(f);
  console.log(C.b + 'verify' + C.reset + ' level=' + level + '  target=' + TARGET + '\n');
  let ok = true;
  if (level >= 1) {
    const l1 = verify.l1Static(TARGET, [...rels], py);
    ok = ok && l1.ok;
    console.log('  L1 静态   ' + (l1.ok ? paint('✔ ' + l1.checks.length + ' 项', C.g) : paint('✖', C.r)));
    for (const c of l1.checks.filter((x) => !x.ok)) console.log('     ' + paint('✖', C.r) + ' ' + c.name + ' ' + c.detail);
  }
  if (level >= 2) {
    const l2 = verify.l2Runtime(TARGET, CAPS, py);
    ok = ok && l2.ok;
    console.log('  L2 运行时 ' + (l2.ok ? paint('✔ ' + l2.checks.length + ' 项', C.g) : paint('✖', C.r)));
    for (const c of l2.checks.filter((x) => !x.ok)) console.log('     ' + paint('✖', C.r) + ' ' + c.name + ' ' + c.detail);
  }
  if (level >= 3) {
    const l3 = verify.l3E2E(TARGET, { prompt: args.prompt });
    ok = ok && l3.ok;
    console.log('  L3 端到端 ' + (l3.ok ? paint('✔', C.g) : paint('✖', C.r)) + ' ' + (l3.checks[0] || {}).detail);
  }
  metrics.record(TARGET, { event: 'verify', level, ok });
  console.log('\n' + (ok ? paint('通过', C.g) : paint('未通过', C.r)));
  if (!ok) process.exitCode = 1;
}

/* ───────────── revert / doctor / stats ───────────── */

function cmdRevert() {
  // 顺序很重要：事务管着的 shim 文件交给 revert（它要校验哈希），
  // 只有「不在任何快照里」的残留 shim 才在这里直接删。
  const covered = txn.coveredPaths(TARGET, { id: args.id });
  const r0 = shim.uninstall(TARGET, { skip: covered });
  if (r0.removed.length) console.log('已移除 shim：' + r0.removed.length + ' 个文件');
  const r = txn.revert(TARGET, { force: !!args.force, id: args.id });
  if (!r.ok) {
    console.log(paint('回滚未完成：' + (r.reason || '') , C.r));
    if (r.drifted && r.drifted.length) {
      console.log('  以下文件被外部改过，未覆盖（--force 可强上）：');
      for (const d of r.drifted) console.log('   ' + paint('!', C.y) + ' ' + d);
    }
    process.exitCode = 1;
    return;
  }
  console.log('回滚 ' + r.restored.length + ' 个文件（sha256 已校验）');
  for (const f of r.restored) console.log('  ' + paint('↩', C.y) + ' ' + f);
  metrics.record(TARGET, { event: 'revert', restored: r.restored.length });
}

function cmdDoctor() {
  const rep = txn.doctor(TARGET);
  console.log(C.b + 'doctor' + C.reset + '  target=' + TARGET + '\n');
  for (const c of rep.checks) {
    console.log('  ' + (c.ok ? paint('✔', C.g) : paint('✖', C.r)) + ' ' + c.name.padEnd(16) + ' ' + C.dim + c.detail + C.reset);
  }
  const log = shim.readLog(TARGET);
  if (log.length) {
    const bad = log.filter((l) => l.ok === false);
    console.log('\n  shim 日志 ' + log.length + ' 条，失败 ' + bad.length + ' 条');
    for (const b of bad.slice(0, 5)) console.log('   ' + paint('✖', C.r) + ' ' + JSON.stringify(b));
  }
  console.log('\n' + (rep.ok ? paint('健康', C.g) : paint('有问题', C.y)));
  if (!rep.ok) process.exitCode = 1;
}

/** 终端里 CJK 占两格，padEnd 按字符数会错位 —— 自己算显示宽度 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide = c >= 0x1100 && (
      c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(s, n) {
  const w = dispWidth(s);
  return w >= n ? String(s) : String(s) + ' '.repeat(n - w);
}

function fmtInt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(x) {
  return x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%';
}

function listOf(obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return '（无）';
  return keys.map((k) => k + ' ' + obj[k]).join(' · ');
}

function cmdStats() {
  const s = metrics.stats(TARGET, { since: args.since });
  if (args.json) { console.log(JSON.stringify(Object.assign({ target: TARGET }, s), null, 2)); return; }

  console.log(C.b + 'stats' + C.reset + '  target=' + TARGET);
  console.log(C.dim + metrics.file(TARGET) + C.reset);
  console.log(C.dim + '轮次 ' + s.turnRows + ' · 引擎事件 ' + s.eventRows + ' · shim 日志行 ' + s.capRows + C.reset + '\n');

  const line = (k, v) => console.log('  ' + C.dim + padTo(k, 12) + C.reset + v);

  console.log('  ' + C.c + '── 轮次 ──' + C.reset);
  if (!s.hasTurns) {
    console.log('  ' + C.y + '还没有轮次数据（跑一轮 hp 或 dashboard 会话后再看）' + C.reset);
  } else {
    line('轮次总数', String(s.turnRows));
    line('拒答命中', s.refusalHits + ' (' + fmtPct(s.refusalRate) + ')  ' +
      C.dim + '平均重采样 ' + (s.avgNudges === null ? 'n/a' : s.avgNudges) + '/轮 · 合计 ' + s.nudgeTotal + C.reset);
    line('异常轮次', String(s.failedTurns) + C.dim + '  (ok:false)' + C.reset);
    line('surface', listOf(s.surfaces));
    line('模型', listOf(s.models));
    if (s.nudgeMissing) {
      line('读数缺失', C.y + s.nudgeMissing + ' 轮没有 _purge_refusal_nudges（C18c 未落地？）' + C.reset);
    }
  }

  console.log('\n  ' + C.c + '── tokens / 成本 ──' + C.reset);
  if (!s.tokens.turns) {
    line('tokens', C.y + 'n/a' + C.reset + C.dim + '（宿主没吐出 usage 计数，不猜）' + C.reset);
    line('估算成本', C.y + 'n/a' + C.reset + C.dim + '（没有 token 就没有成本）' + C.reset);
  } else {
    line('tokens', '入 ' + fmtInt(s.tokens.in) + ' · 出 ' + fmtInt(s.tokens.out) +
      C.dim + '（' + s.tokens.turns + ' 轮有数据' +
      (s.tokens.turnsMissing ? '，' + s.tokens.turnsMissing + ' 轮缺' : '') + '）' + C.reset);
    if (s.cost.usd === null) {
      line('估算成本', C.y + 'n/a' + C.reset + C.dim + '（模型不在默认价目表里：' + s.cost.unpriced.join(', ') + '）' + C.reset);
    } else {
      line('估算成本', paint('$' + s.cost.usd.toFixed(4), C.g) + C.dim + '  （默认价目表，USD / 1M tokens）' + C.reset);
      for (const g of s.cost.byModel) {
        const price = g.price ? '$' + g.price.in + '/$' + g.price.out : '无价目';
        console.log('  ' + ' '.repeat(12) + C.dim + padTo(g.model, 26) + fmtInt(g.tokensIn) + ' in · ' +
          fmtInt(g.tokensOut) + ' out · ' + price +
          (g.usd === null ? ' · n/a' : ' · $' + g.usd.toFixed(4)) + C.reset);
      }
      if (s.cost.unpricedModels) {
        console.log('  ' + ' '.repeat(12) + C.y + '未定价：' + s.cost.unpriced.join(', ') + C.reset);
      }
    }
  }

  console.log('\n  ' + C.c + '── cap 命中（shim.log）──' + C.reset);
  if (!s.capRows) {
    line('cap 命中', C.y + '还没有 shim 落地记录' + C.reset + C.dim + '（purge apply 后跑一轮）' + C.reset);
  } else {
    line('cap 命中', listOf(s.byCap));
    if (Object.keys(s.capFails).length) line('落地失败', paint(JSON.stringify(s.capFails), C.r));
    if (s.capUnlabeled) line('无 cap 行', String(s.capUnlabeled) + C.dim + '  (turn-hook / attr-missing)' + C.reset);
  }

  if (s.eventRows) {
    console.log('\n  ' + C.c + '── 引擎事件 ──' + C.reset);
    line('事件', listOf(s.eventsByType));
  }
  if (!s.hasTurns) console.log('\n' + C.dim + '提示：stats 读的是 ' + metrics.file(TARGET) + '，' +
    '由宿主进程里的 shim 每轮追加。' + C.reset);
}

/* ───────────── 入口 ───────────── */

const cmd = args._[0] || 'status';
switch (cmd) {
  case 'status': cmdStatus(); break;
  case 'apply': cmdApply(); break;
  case 'verify': cmdVerify(); break;
  case 'revert': cmdRevert(); break;
  case 'doctor': cmdDoctor(); break;
  case 'stats': cmdStats(); break;
  default:
    console.log(usageText());
}