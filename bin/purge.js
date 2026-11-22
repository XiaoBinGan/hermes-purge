#!/usr/bin/env node
'use strict';
/**
 * purge —— hermes-purge v2 引擎（capability layer，宿主无关）
 *
 *   purge status  [--json] [--target=DIR] [--adapter=hermes|dsh|auto]
 *   purge apply   [--dry] [--no-verify] [--target=DIR] [--adapter=...]
 *   purge verify  [--level=1|2|3] [--target=DIR] [--adapter=...]
 *   purge revert  [--force] [--id=SNAP] [--target=DIR] [--adapter=...]
 *   purge doctor  [--target=DIR] [--adapter=...]
 *   purge stats   [--json] [--since=ISO] [--target=DIR]
 *   purge --help|-h / --version|-v
 *
 * 引擎不认识具体宿主：cap 清单、实现分发、shim 注入、验证都在 adapters/<name>/。
 * 这个文件只做参数、事务、日志与调度；加新宿主不用改这里。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../lib/core');
const txn = require('../lib/v2/txn');
const metrics = require('../lib/v2/metrics');
const capsLib = require('../lib/v2/caps');
const adapters = require('../lib/v2/adapters');
const platform = require('../lib/v2/platform');

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
    '  purge setup  [--yes] [--dry] 一条命令：检测 → 计划 → 应用 → 验证',
    '  purge uninstall [--yes]      撤销补丁 + 删状态目录（卸干净）',
    '  purge status [--json]        每条 cap 当前走哪层实现',
    '  purge apply  [--dry]         事务式应用（快照 → 写 → 校验）',
    '  purge verify [--level=1|2|3] 静态 / 运行时 / 端到端',
    '  purge revert [--force]       按 manifest 逐字节还原',
    '  purge doctor                 体检：哈希漂移 / 临时文件 / shim',
    '  purge report [--open] [--out=F]  生成单文件 HTML 状态报告（离线可开，能发给别人）',
    '  purge plugin [install|uninstall|status]  装一个 Hermes 插件：/purge 命令 + purge_status 工具',
    '  purge stats [--json] [--since=ISO]  观测：轮次、拒答收敛、cap 命中、成本',
    '',
    '  --target=DIR   指定宿主目录（默认自动探测，或 HERMES_HOME / DSH_HOME）',
    '  --adapter=K    hermes | dsh | auto（缺省 auto：按目录特征探测）',
    '',
    '  已注册 adapter：',
    adapters.describe(),
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

function hermesDefault() {
  const r = core.resolveHermesRoot(args.home);
  if (!r) return null;
  return fs.existsSync(path.join(r, 'hermes_cli')) ? r : path.join(r, 'hermes-agent');
}

function dshDefault() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return fs.existsSync(home) ? home : null;
}

/* ───────────── adapter 选择 ───────────── */

const ADAPTER_FLAG = args.adapter === true || args.adapter === undefined ? 'auto' : String(args.adapter);
const EXPLICIT = ADAPTER_FLAG === 'auto' ? null : ADAPTER_FLAG;

const TARGET = args.target ? path.resolve(args.target)
  : (EXPLICIT === 'dsh' ? dshDefault() : hermesDefault());

if (!TARGET || !fs.existsSync(TARGET)) {
  console.error(EXPLICIT === 'dsh'
    ? '找不到 DSH 安装目录。用 --target=DIR 指定，或设 DSH_HOME。'
    : '找不到 Hermes 安装目录。用 --target=DIR 指定，或设 HERMES_HOME。');
  process.exit(3);
}

let ADAPTER_ID = EXPLICIT;
if (!ADAPTER_ID) {
  try {
    ADAPTER_ID = adapters.resolve({ target: TARGET, undetected: 'throw' }).id;
  } catch (e) {
    console.error(e.message);
    console.error('  已注册：');
    console.error(adapters.describe());
    process.exit(3);
  }
}

let ADAPTER;
try {
  ADAPTER = adapters.get(ADAPTER_ID);
} catch (e) {
  console.error(e.message);
  process.exit(3);
}

const py = ADAPTER.host.find(TARGET);
const CAPS = capsLib.buildCaps({ adapter: ADAPTER.id, target: TARGET });
const ctx = { target: TARGET, py, shimEntries: [], adapter: ADAPTER.id };

/* ───────────── 实现选择 ───────────── */

function probeChain(cap) {
  const tried = [];
  const only = args.impl ? String(args.impl) : null;
  for (const impl of cap.impls) {
    if (only && impl.kind !== only) continue;
    const st = ADAPTER.probeImpl(impl, cap.id, ctx);

    if (st && (st.status === 'applied' || st.status === 'pending')) {
      return { impl, status: st.status, detail: st.detail, kind: impl.kind, tried };
    }
    tried.push(impl.kind + ':' + (st ? st.status : 'n/a'));

    // 文本层失败时试宿主提供的变体（hermes 的 0.21.0 锚点）
    if (impl.kind === 'text' && cap.variants && cap.variants.length) {
      for (const v of cap.variants) {
        const vs = ADAPTER.probeVariant(v.spec, cap.id, ctx);
        if (vs.status === 'applied' || vs.status === 'pending') {
          return { impl: { kind: 'text', spec: v.spec }, status: vs.status, detail: vs.detail, kind: 'text', tried, variant: true };
        }
        tried.push('variant:' + vs.status);
      }
    }
  }
  return { impl: null, status: 'drifted', detail: '所有实现都不可用', kind: null, tried };
}
ctx.probe = probeChain;

/* ───────────── status ───────────── */

/** 每条 cap 的当前状态（status 与 report 共用同一份数据，避免两处口径漂移） */
function collectRows() {
  return CAPS.map((cap) => {
    const r = probeChain(cap);
    return { id: cap.id, cap: cap.cap, layer: cap.layer, impl: r.kind, status: r.status, detail: r.detail, tried: r.tried };
  });
}

function cmdStatus() {
  const rows = collectRows();
  if (args.json) {
    console.log(JSON.stringify({ target: TARGET, adapter: ADAPTER.id, python: py, rows }, null, 2));
    return;
  }

  const by = (s) => rows.filter((r) => r.status === s).length;
  console.log(C.b + 'purge v2' + C.reset + (ADAPTER.id === 'hermes' ? '' : ' ' + C.dim + '· ' + ADAPTER.id + C.reset) + '  target=' + TARGET);
  console.log(ADAPTER.host.label + '=' + (py || '(无)') + '  ·  caps ' + rows.length + '  ·  ' +
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
  const out = ADAPTER.shimRelPaths ? ADAPTER.shimRelPaths(TARGET) : [];
  return out || [];
}

function cmdApply() {
  const dry = !!args.dry;
  const rels = new Set();
  for (const cap of CAPS) for (const f of capsLib.filesOf(cap)) rels.add(f);
  if (!dry) for (const r of shimRelPaths()) rels.add(r);

  console.log(C.b + (dry ? '[dry] 预演' : '应用') + C.reset + ' → ' + TARGET);
  console.log(C.dim + '事务文件 ' + rels.size + ' 个；' + ADAPTER.host.label + '=' + (py || '(无)') + C.reset + '\n');

  const snap = dry ? null : txn.begin(TARGET, [...rels]);
  let changed = 0, skipped = 0, failed = 0;

  try {
    for (const cap of CAPS) {
      const r = probeChain(cap);
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
      const res = ADAPTER.applyImpl(r.impl, cap.id, ctx);
      if (r.kind === 'text') {
        done = res.changed;
        console.log('  ' + (done ? paint('✔', C.g) : paint('·', C.y)) + ' ' + cap.id + ' ' + paint('text', C.c) + ' ' + res.detail);
      } else if (r.kind === 'shim') {
        if (res.changed) { done = true; console.log('  ' + paint('✔', C.g) + ' ' + cap.id + ' ' + paint('shim', C.c) + ' ' + res.detail); }
      } else if (res.changed) {
        done = true;
        console.log('  ' + paint('✔', C.g) + ' ' + cap.id + ' ' + paint(r.kind, C.c) + ' ' + res.detail);
      }

      // 首选失败 → 降级到后面的文本/配置实现（AST 挂了就写文本）
      if (!done) {
        const idx = cap.impls.findIndex((i) => i === r.impl);
        for (let i = idx + 1; i < cap.impls.length; i++) {
          const impl = cap.impls[i];
          if (impl.kind !== 'text' && impl.kind !== 'conf') continue;
          let use = impl;
          let st = ADAPTER.probeImpl(use, cap.id, ctx);
          if (st.status !== 'pending' && st.status !== 'applied' && cap.variants) {
            for (const v of cap.variants) {
              const vs = ADAPTER.probeVariant(v.spec, cap.id, ctx);
              if (vs.status === 'pending' || vs.status === 'applied') { use = { kind: 'text', spec: v.spec }; st = vs; break; }
            }
          }
          const res2 = ADAPTER.applyImpl(use, cap.id, ctx);
          if (res2.changed) { done = true; console.log('  ' + paint('✔', C.g) + ' ' + cap.id + ' ' + paint(impl.kind + '(fallback)', C.c) + ' ' + res2.detail); break; }
        }
      }

      if (done) changed++; else { failed++; console.log('  ' + paint('✖', C.r) + ' ' + cap.id + ' 降级后仍未落地'); }
    }

    // shim 收尾：整表写入（只写一遍）
    if (!dry) {
      ctx.shimEntries = ADAPTER.collectShim(CAPS);
      if (ctx.shimEntries.length) {
        const res = ADAPTER.installShim(TARGET, ctx.shimEntries);
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
      const l1 = ADAPTER.verifyL1(TARGET, [...rels], ctx);
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
    const l1 = ADAPTER.verifyL1(TARGET, [...rels], ctx);
    ok = ok && l1.ok;
    console.log('  L1 静态   ' + (l1.ok ? paint('✔ ' + l1.checks.length + ' 项', C.g) : paint('✖', C.r)));
    for (const c of l1.checks.filter((x) => !x.ok)) console.log('     ' + paint('✖', C.r) + ' ' + c.name + ' ' + c.detail);
  }
  if (level >= 2) {
    const l2 = ADAPTER.verifyL2(TARGET, CAPS, ctx);
    ok = ok && l2.ok;
    console.log('  L2 运行时 ' + (l2.ok ? paint('✔ ' + l2.checks.length + ' 项', C.g) : paint('✖', C.r)));
    for (const c of l2.checks.filter((x) => !x.ok)) console.log('     ' + paint('✖', C.r) + ' ' + c.name + ' ' + c.detail);
    for (const c of l2.checks.filter((x) => x.skipped)) console.log('     ' + paint('·', C.y) + ' ' + c.name + ' ' + c.detail);
  }
  if (level >= 3) {
    const l3 = ADAPTER.verifyL3(TARGET, { prompt: args.prompt });
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
  const r0 = ADAPTER.uninstallShim ? ADAPTER.uninstallShim(TARGET, { skip: covered }) : { removed: [] };
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

/* ───────────── Hermes 插件（无损扩展）───────────── */

function pluginDir() {
  // 插件装在「配置根」下：~/.hermes/plugins/hermes_purge（或 $HERMES_HOME/plugins/…）
  const env = process.env.HERMES_HOME;
  const cfgRoot = (env && fs.existsSync(path.join(env, 'config.yaml')))
    ? path.resolve(env)
    : path.resolve(TARGET, '..');
  return path.join(cfgRoot, 'plugins', 'hermes_purge');
}

function cmdPlugin() {
  const sub = args._[1] || 'status';
  const dest = pluginDir();
  const src = path.join(__dirname, '..', 'lib', 'v2', 'plugin');

  if (sub === 'install') {
    if (!fs.existsSync(path.join(src, 'plugin.yaml'))) {
      console.error('找不到插件模板：' + src);
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['plugin.yaml', '__init__.py']) {
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
    }
    fs.writeFileSync(path.join(dest, 'path.json'), JSON.stringify({
      cli: path.join(__dirname, 'purge.js'),
      node: platform.which('node') || process.execPath,
      installedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    console.log('插件已安装 → ' + dest);
    console.log('  /purge [status|report|doctor|stats]   会话内看状态');
    console.log('  purge_status                          工具（agent 自己回答开没开）');
    console.log('\n重启 Hermes 后生效（插件在启动时加载）。卸载：purge plugin uninstall');
    return;
  }

  if (sub === 'uninstall') {
    if (!fs.existsSync(dest)) { console.log('没装过（' + dest + ' 不存在）'); return; }
    fs.rmSync(dest, { recursive: true, force: true });
    console.log('插件已删除：' + dest + '（重启 Hermes 生效）');
    return;
  }

  // status
  const has = fs.existsSync(path.join(dest, 'plugin.yaml'));
  console.log('插件目录  ' + dest);
  console.log('状态      ' + (has ? '已安装（重启 Hermes 后生效/生效中）' : '未安装 —— purge plugin install'));
  if (has) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(dest, 'path.json'), 'utf8'));
      const ok = pj.cli && fs.existsSync(pj.cli);
      console.log('CLI 指向  ' + (pj.cli || '(缺)') + (ok ? '  ✔' : '  ✖ 文件不存在'));
    } catch (e) { console.log('path.json  读取失败：' + e.message); }
  }
}

function cmdReport() {
  const report = require('../lib/v2/report');
  const rows = collectRows();
  const doctorOpts = ADAPTER.doctorOpts ? ADAPTER.doctorOpts(TARGET) : undefined;
  const doc = txn.doctor(TARGET, doctorOpts);
  const st = metrics.stats(TARGET, {});
  const audit = txn.readAudit ? txn.readAudit(TARGET, 15) : [];
  const hostVersion = (() => {
    try {
      const pj = fs.readFileSync(path.join(TARGET, 'pyproject.toml'), 'utf8');
      const m = pj.match(/^version\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1];
    } catch (e) { /* 忽略 */ }
    try {
      const hc = fs.readFileSync(path.join(TARGET, 'hermes_constants.py'), 'utf8');
      const m = hc.match(/__version__\s*=\s*["']([^"']+)["']/);
      if (m) return m[1];
    } catch (e) { /* 忽略 */ }
    return null;
  })();

  const html = report.render({
    target: TARGET, adapter: ADAPTER.id, version: pkgVersion(),
    hostVersion, python: py, rows, doctor: doc, stats: st, audit,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  });
  const out = args.out && args.out !== true
    ? path.resolve(String(args.out))
    : path.join(process.cwd(), 'purge-report.html');
  const w = report.write(out, html);
  console.log('状态报告 → ' + w.file + '  (' + Math.round(w.bytes / 1024) + ' KB)');
  const by = (x) => rows.filter((r) => r.status === x).length;
  console.log('  ' + by('applied') + '/' + rows.length + ' 生效 · 待应用 ' + by('pending') + ' · 不可用 ' + by('drifted'));
  if (args.open) {
    const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
    try {
      require('child_process').spawn(cmd, [w.file], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    } catch (e) { /* 打不开就算了，路径已经打印 */ }
  }
}

function cmdDoctor() {
  const opts = ADAPTER.doctorOpts ? ADAPTER.doctorOpts(TARGET) : undefined;
  const rep = txn.doctor(TARGET, opts);
  console.log(C.b + 'doctor' + C.reset + '  target=' + TARGET + '\n');
  for (const c of rep.checks) {
    console.log('  ' + (c.ok ? paint('✔', C.g) : paint('✖', C.r)) + ' ' + c.name.padEnd(16) + ' ' + C.dim + c.detail + C.reset);
  }
  const log = ADAPTER.readShimLog ? ADAPTER.readShimLog(TARGET) : [];
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

/* ───────────── setup / uninstall ───────────── */

/** 用子进程跑自己的某个子命令，stdout/stderr 直通（隔离失败，setup 只管编排） */
function runSelf(argv) {
  const r = require('child_process').spawnSync(
    process.execPath,
    [__filename].concat(argv, ['--target=' + TARGET, '--adapter=' + ADAPTER.id]),
    { stdio: 'inherit', windowsHide: true }
  );
  return r.status === 0;
}

function ask(question) {
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(String(a || '').trim().toLowerCase()); });
  });
}

async function cmdSetup() {
  const yes = args.yes === true || args.y === true;
  const dry = args.dry === true;
  const rows = CAPS.map((cap) => ({ cap, r: probeChain(cap) }));
  const count = (st) => rows.filter((x) => x.r.status === st).length;
  const pend = rows.filter((x) => x.r.status === 'pending');

  console.log(C.b + 'purge setup' + C.reset + '  —— 检测 → 计划 → 应用 → 验证');
  console.log('  宿主    ' + (ADAPTER.label || ADAPTER.id) + '  ·  ' + ADAPTER.host.label + '=' + (py || '(无)'));
  console.log('  目录    ' + TARGET);
  console.log('  cap     ' + CAPS.length + ' 条  ·  ' +
    paint('已生效 ' + count('applied'), C.g) + '  ' +
    paint('待应用 ' + pend.length, C.y) + '  ' +
    paint('不可用 ' + count('drifted'), C.r));
  if (count('drifted')) {
    console.log('\n  ' + paint('不可用的 cap（版本/布局不匹配，apply 会跳过）:', C.y));
    for (const x of rows.filter((y) => y.r.status === 'drifted')) {
      console.log('   ' + paint('✖', C.r) + ' ' + x.cap.id + ' ' + x.cap.cap + '  ' + C.dim + x.r.detail + C.reset);
    }
  }
  if (!pend.length) {
    console.log('\n' + paint('已经是干净的应用状态，无需写入。', C.g));
    console.log('  验证一下：  purge verify --level=2');
    return;
  }
  console.log('\n  即将应用（按实现层）: ' +
    C.dim + ['ast', 'shim', 'text', 'conf']
      .map((k) => k + ' ' + pend.filter((x) => x.r.kind === k).length).join(' · ') + C.reset);
  for (const x of pend) {
    console.log('   ' + paint('·', C.y) + ' ' + String(x.cap.id).padEnd(5) +
      paint('[' + x.r.kind + ']', C.c) + ' ' + x.cap.cap);
  }
  if (dry) { console.log('\n（--dry 预演，未写入）'); return; }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log('\n非交互环境：加 --yes 才会真正写入。例：purge setup --yes');
      process.exitCode = 1;
      return;
    }
    const a = await ask('\n写入这些改动？[y/N] ');
    if (a !== 'y' && a !== 'yes') { console.log('已取消，什么都没改。'); return; }
  }

  console.log('\n' + C.b + '① 应用' + C.reset);
  const okApply = runSelf(['apply', '--no-verify']);
  if (!okApply) { console.log(paint('\napply 失败，已按事务回滚。看 purge doctor。', C.r)); process.exitCode = 1; return; }

  console.log('\n' + C.b + '② 验证' + C.reset);
  const okVerify = runSelf(['verify', '--level=2']);
  console.log('\n' + C.b + '③ 下一步' + C.reset);
  console.log('  重启宿主进程才生效（approval 状态在 import 期冻结）');
  console.log('  仪表盘：  hermes dashboard --port 9119');
  console.log('  看数据：  purge stats');
  console.log('  回滚：    purge revert' + (okVerify ? '' : paint('   （当前 verify 未全绿，见上）', C.y)));
  if (!okVerify) process.exitCode = 1;
}

async function cmdUninstall() {
  const yes = args.yes === true || args.y === true;
  if (!yes) {
    if (!process.stdin.isTTY) { console.log('非交互环境：加 --yes。例：purge uninstall --yes'); process.exitCode = 1; return; }
    const a = await ask('撤销全部补丁并删除 ' + path.join(TARGET, '.hermes-purge') + '？[y/N] ');
    if (a !== 'y' && a !== 'yes') { console.log('已取消。'); return; }
  }
  console.log(C.b + '① 还原文件' + C.reset);
  const okRevert = runSelf(['revert']);
  if (!okRevert) console.log(C.dim + '  （没有可还原的快照，或文件被外部改过 —— 继续清状态目录）' + C.reset);
  const stateDir = path.join(TARGET, '.hermes-purge');
  if (fs.existsSync(stateDir)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    console.log('已删除状态目录 ' + stateDir);
  }
  // 1.x 的 .bak 与 v2 是两套，提示别混淆
  const baks = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!platform.SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.hermes-purge.bak')) baks.push(path.join(dir, e.name));
    }
  };
  walk(TARGET);
  if (baks.length) {
    console.log('\n' + paint('注意：还有 ' + baks.length + ' 个 1.x 版备份（.hermes-purge.bak）', C.y));
    console.log('  那是老引擎留下的，v2 不依赖它们。要连 1.x 一起撤：node bin/hermes-purge.js --revert');
  }
  console.log('\n清干净了。装回来：purge setup');
}

/* ───────────── 入口 ───────────── */

const cmd = args._[0] || 'status';
switch (cmd) {
  case 'status': cmdStatus(); break;
  case 'apply': cmdApply(); break;
  case 'verify': cmdVerify(); break;
  case 'revert': cmdRevert(); break;
  case 'doctor': cmdDoctor(); break;
  case 'report': cmdReport(); break;
  case 'plugin': cmdPlugin(); break;
  case 'stats': cmdStats(); break;
  case 'setup': cmdSetup(); break;
  case 'uninstall': cmdUninstall(); break;
  default:
    console.log(usageText());
}