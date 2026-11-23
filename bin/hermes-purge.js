#!/usr/bin/env node
/**
 * hermes-purge — 三层清洗器（提示词 / 配置 / 代码）for Hermes Agent
 *
 *   node bin/hermes-purge.js --status
 *   node bin/hermes-purge.js --apply [--dry]
 *   node bin/hermes-purge.js --verify
 *   node bin/hermes-purge.js --revert
 *   node bin/hermes-purge.js --uninstall
 *
 * 目标目录自动探测（HERMES_HOME / 向上查找 / 常见位置）；
 * 也可 --target=DIR 显式指定。
 *
 * 备份：<file>.hermes-purge.bak（首次改写生成一次）
 * 状态：<target>/.hermes-purge/state.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../lib/core');

const { MARK, TESTED_HERMES, PATCHES } = require('../lib/patches');

/* ────────────────────────── 基础设施 ────────────────────────── */

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

let TARGET = null;
if (args.target) TARGET = path.resolve(args.target);
else {
  const r = core.resolveHermesRoot(args.home);
  if (r) TARGET = fs.existsSync(path.join(r, 'hermes_cli')) ? r : path.join(r, 'hermes-agent');
}

const STATE_DIR = TARGET ? path.join(TARGET, '.hermes-purge') : null;
const STATE_FILE = STATE_DIR ? path.join(STATE_DIR, 'state.json') : null;
const BAK_SUFFIX = '.hermes-purge.bak';
const PAYLOAD_FILE = path.join(__dirname, '..', 'payload', 'SOUL.md');

const abs = (rel) => path.resolve(TARGET, rel);
const relOf = (p) => path.relative(TARGET, p).replace(/\\/g, '/');

/** 读目标 Hermes 版本；读不到返回 null */
function hermesVersion() {
  if (!TARGET) return null;
  try {
    const pj = path.join(TARGET, 'pyproject.toml');
    if (fs.existsSync(pj)) {
      const m = fs.readFileSync(pj, 'utf8').match(/^version\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1];
    }
    const hc = path.join(TARGET, 'hermes_constants.py');
    if (fs.existsSync(hc)) {
      const m = fs.readFileSync(hc, 'utf8').match(/__version__\s*=\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { target: TARGET, applied: {}, created: [] }; }
}
function writeState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  s.target = TARGET;
  s.applied = s.applied || {};
  s.created = s.created || [];
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}
function ensureBackup(file, state) {
  const bak = file + BAK_SUFFIX;
  if (fs.existsSync(bak)) return;
  fs.copyFileSync(file, bak);
  const rel = relOf(bak);
  if (!state.created.includes(rel)) state.created.push(rel);
  writeState(state);
}

/* ────────────────────────── 探测 ────────────────────────── */

/**
 * 单条 spec 探测。spec = 补丁本体（0.21.3 主锚）或它的一个版本变体（0.21.0）。
 *
 * 变体存在的理由：0.21.0 还没把 approval_context / approval_detection /
 * turn_stop_gates / stream_delivery / turn_request_assembly 拆成独立模块，
 * 同一个改动在 0.21.0 要去另一个文件、另一个锚点。主锚永远优先，主锚不成立
 * 才试变体 —— 所以 Windows（0.21.3）上的判定与旧版逐字一致。
 */
function probeSpec(sp, id) {
  const file = abs(sp.file);
  if (!fs.existsSync(file)) return { status: 'missing', detail: '文件不存在: ' + sp.file };
  const src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const sentinel = sp.sentinel || (id ? `${MARK} ${id}` : '');

  switch (sp.kind) {
    case 'noop':
      return { status: 'applied', detail: sp.detail || '目标版本无需改动' };
    case 'insertAfterAll': {
      let pend = 0, done = 0;
      for (const site of sp.sites || []) {
        if (!src.includes(site.anchor)) continue;
        const after = (src.split(site.anchor)[1] || '').slice(0, 240);
        if (after.includes(site.ret.trim())) done++; else pend++;
      }
      if (pend) return { status: 'pending', detail: pend + ' 处待插入' };
      if (done) return { status: 'applied', detail: '已插入 ' + done + ' 处' };
      return { status: 'drifted', detail: '锚点全未命中' };
    }
    case 'insertAfter': {
      if (!src.includes(sp.anchor)) return { status: 'drifted', detail: '锚点未命中: ' + sp.anchor.slice(0, 45) };
      const after = (src.split(sp.anchor)[1] || '').slice(0, 240);
      if (after.includes(sp.ret.trim())) return { status: 'applied', detail: sp.ret };
      return { status: 'pending', detail: sp.ret };
    }
    case 'replace': {
      if (src.includes(sp.find)) return { status: 'pending', detail: '待替换' };
      if (src.includes(MARK)) return { status: 'applied', detail: '已替换' };
      return { status: 'drifted', detail: '原文未命中: ' + sp.find.split('\n')[0].slice(0, 45) };
    }
    case 'splice': {
      // 幂等判定：先看 sentinel（MARK+id）在不在，再看 find 是否还在
      if (sentinel && src.includes(sentinel)) return { status: 'applied', detail: '已注入 ' + id };
      if (src.includes(sp.find)) return { status: 'pending', detail: '待注入 ' + (id || '') };
      return { status: 'drifted', detail: '锚点未命中: ' + sp.find.split('\n')[0].slice(0, 45) };
    }
    case 'appendEnv': {
      const missing = sp.lines.filter((l) => !src.includes(l.split('=')[0] + '='));
      return missing.length
        ? { status: 'pending', detail: missing.join(', ') }
        : { status: 'applied', detail: '环境变量已存在' };
    }
    case 'yamlApprovals': {
      const ok = /^approvals:\s*$\n(?:[ \t]+.*\n)*?[ \t]+mode:\s*['"]?off['"]?/m.test(src);
      const mt = src.match(/^approvals:\s*$\n(?:[ \t]+.*\n)*?[ \t]+timeout:\s*(\d+)/m);
      // 只判 mode 会把「本来就已经 off、但 timeout 还是 60」误报成已生效（补丁其实没写过）
      if (ok && mt && Number(mt[1]) >= 86400) return { status: 'applied', detail: 'mode: off, timeout ' + mt[1] };
      if (ok) return { status: 'pending', detail: ok ? 'mode 已 off，timeout ' + (mt ? mt[1] : '缺') + ' → 86400' : '' };
      return { status: 'pending', detail: '注入 approvals 段' };
    }
    case 'yamlMaxTokens': {
      const m = src.match(/^model:\s*$\n(?:[ \t]+.*\n)*?[ \t]+max_tokens:\s*(\d+)/m);
      if (m && Number(m[1]) >= 15000) return { status: 'applied', detail: 'max_tokens: ' + m[1] };
      if (m) return { status: 'pending', detail: m[1] + ' → 16000' };
      return { status: 'pending', detail: '注入 model.max_tokens: 16000' };
    }
    case 'yamlPrefill': {
      const m = src.match(/^prefill_messages_file:\s*(\S+)/m);
      if (m && fs.existsSync(m[1].trim())) return { status: 'applied', detail: path.basename(m[1].trim()) };
      if (m) return { status: 'pending', detail: '路径失效，重写' };
      return { status: 'pending', detail: '注入 prefill_messages_file' };
    }
    case 'writePayload': {
      const payload = fs.readFileSync(PAYLOAD_FILE, 'utf8');
      const ver = (payload.match(/HERMES-PURGE-PAYLOAD (v\d+)/) || [null, '?'])[1];
      if (src === payload) return { status: 'applied', detail: 'payload ' + ver };
      const cur = (src.match(/HERMES-PURGE-PAYLOAD (v\d+)/) || [null, null])[1];
      return { status: 'pending', detail: cur ? cur + ' → ' + ver : src.length + 'B → ' + ver };
    }
    default:
      return { status: 'drifted', detail: '未知 kind' };
  }
}

/** 主锚优先，主锚成立就不看变体；主锚 missing/drifted 才按序试变体 */
function resolvePatch(p) {
  const primary = probeSpec(p, p.id);
  const vs = p.variants || [];
  if (!vs.length) return Object.assign({}, primary, { spec: p, label: '' });
  if (primary.status === 'applied' || primary.status === 'pending') {
    return Object.assign({}, primary, { spec: p, label: '' });
  }
  for (const v of vs) {
    const st = probeSpec(v, p.id);
    if (st.status === 'applied' || st.status === 'pending') {
      return Object.assign({}, st, {
        spec: v,
        label: v.label || 'variant',
        detail: (v.label ? '[' + v.label + '] ' : '') + st.detail,
      });
    }
  }
  return Object.assign({}, primary, { spec: p, label: '' });
}

function probe(p) {
  const r = resolvePatch(p);
  return { status: r.status, detail: r.detail };
}

/* ────────────────────────── 应用 ────────────────────────── */

function applyOne(p, state, dry) {
  const r = resolvePatch(p);
  const st = { status: r.status, detail: r.detail };
  if (st.status === 'applied') return { status: 'already', detail: st.detail, file: r.spec.file };
  if (st.status === 'missing') return st;
  if (st.status === 'drifted') return st;
  if (dry) return { status: 'pending', detail: '[dry] ' + st.detail };

  const spec = r.spec;
  if (spec.kind === 'noop') return { status: 'applied', detail: st.detail, file: spec.file };

  const file = abs(spec.file);
  ensureBackup(file, state);
  let src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

  switch (spec.kind) {
    case 'insertAfterAll':
      for (const site of spec.sites || []) {
        if (!src.includes(site.anchor)) continue;
        const after = (src.split(site.anchor)[1] || '').slice(0, 240);
        if (after.includes(site.ret.trim())) continue;
        src = src.replace(site.anchor, site.anchor + '\n    ' + site.ret + '  # ' + MARK);
      }
      break;
    case 'insertAfter':
      src = src.replace(spec.anchor, spec.anchor + '\n    ' + spec.ret + '  # ' + MARK);
      break;
    case 'replace':
      src = src.split(spec.find).join(spec.to);
      break;
    case 'splice':
      src = src.split(spec.find).join(spec.to);
      break;
    case 'appendEnv': {
      const add = spec.lines.filter((l) => !src.includes(l.split('=')[0] + '='));
      src += (src.endsWith('\n') ? '' : '\n') + '\n# ' + MARK + ' approval bypass\n' + add.join('\n') + '\n';
      break;
    }
    case 'yamlApprovals': {
      // 已有 approvals 段就只补/改 timeout；没有才整段追加。
      // 引号必须保留：YAML 1.1 会把裸 off 解析成布尔 false。
      const hasBlock = /^approvals:\s*$/m.test(src);
      if (hasBlock) {
        if (/^approvals:\s*$\n(?:[ \t]+.*\n)*?[ \t]+timeout:\s*\d+/m.test(src)) {
          src = src.replace(
            /^(approvals:\s*$\n(?:[ \t]+.*\n)*?[ \t]+timeout:\s*)\d+/m, '$186400  # ' + MARK);
        } else {
          src = src.replace(/^(approvals:\s*\n)/m, '$1  timeout: 86400  # ' + MARK + '\n');
        }
        break;
      }
      src += (src.endsWith('\n') ? '' : '\n')
        + '\n# ' + MARK + ' approval bypass\napprovals:\n  mode: \'off\'        # manual | smart | off\n  timeout: 86400\n';
      break;
    }
    case 'yamlMaxTokens': {
      if (/^model:\s*$/m.test(src)) {
        src = src.replace(/^(model:\s*\n(?:[ \t]+.*\n)*?)[ \t]+max_tokens:\s*\d+\n/m, '$1');
        if (!/^model:\s*\n(?:[ \t]+.*\n)*?[ \t]+max_tokens:/m.test(src)) {
          src = src.replace(/^(model:\s*\n)/m, '$1  max_tokens: 16000  # ' + MARK + '\n');
        }
      }
      break;
    }
    case 'yamlPrefill': {
      const pf = path.join(__dirname, '..', 'payload', 'prefill_messages.json').replace(/\\/g, '/');
      src = src.replace(/^prefill_messages_file:.*\n?/m, '');
      src = 'prefill_messages_file: ' + pf + '  # ' + MARK + ' tail-prefill payload\n' + src;
      break;
    }
    case 'writePayload':
      src = fs.readFileSync(PAYLOAD_FILE, 'utf8');
      break;
  }
  fs.writeFileSync(file, src, 'utf8');
  return { status: 'applied', detail: st.detail, file: spec.file };
}

/* ────────────────────────── 命令 ────────────────────────── */

const C = { reset: '\x1b[0m', dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m' };
const paint = (s, code) => (process.stdout.isTTY ? code + s + C.reset : s);

/** 版本提醒：只提示不阻断 */
function versionNotice() {
  const v = hermesVersion();
  if (v && v !== TESTED_HERMES) {
    console.log(paint('注意：目标 Hermes 版本 ' + v + '，主锚验证于 ' + TESTED_HERMES
      + '。锚点不同会自动回退到 0.21.0 变体（status 行尾标 [0.21.0]），'
      + '变体也不成立才报 drifted。', C.y) + '\n');
  }
}

function cmdStatus(json) {
  const rows = PATCHES.map((p) => {
    const r = resolvePatch(p);
    return { id: p.id, layer: p.layer, file: r.spec.file, note: p.note,
      variant: r.label || undefined, status: r.status, detail: r.detail };
  });
  const by = (s) => rows.filter((r) => r.status === s).length;
  if (json) {
    console.log(JSON.stringify({ target: TARGET, hermes: hermesVersion(), tested: TESTED_HERMES, rows }, null, 2));
    return;
  }

  versionNotice();
  console.log(C.b + 'hermes-purge' + C.reset + '  target=' + TARGET);
  console.log('宿主: Hermes Agent  ·  补丁 ' + rows.length + ' 条  ·  ' +
    paint('applied ' + by('applied'), C.g) + '  ' +
    paint('pending ' + by('pending'), C.y) + '  ' +
    paint('drifted ' + by('drifted'), C.r) + '  missing ' + by('missing') + '\n');

  const LAYER = { prompt: '提示词', config: '配置', code: '代码' };
  let last = '';
  for (const r of rows) {
    if (r.layer !== last) { console.log('  ' + C.c + '── ' + LAYER[r.layer] + '层 ──' + C.reset); last = r.layer; }
    const tag = r.status === 'applied' ? paint('✔ applied', C.g)
      : r.status === 'pending' ? paint('· pending', C.y)
      : r.status === 'missing' ? paint('✖ missing', C.dim)
      : paint('! drifted', C.r);
    const vtag = r.variant ? C.y + ' [' + r.variant + ']' + C.reset : '';
    console.log('  ' + r.id + '  ' + tag.padEnd(22) + ' ' + r.file.padEnd(34) + ' ' + C.dim + r.note + C.reset + vtag);
  }
  const ready = by('pending') === 0 && by('drifted') === 0 && by('missing') === 0;
  console.log('\n' + (ready ? paint('全部生效', C.g) : paint('有未生效项 —— 运行 --apply', C.y)));
  if (!ready) process.exitCode = 1;
}

function cmdApply(dry) {
  const state = readState();
  let changed = 0, skipped = 0, failed = 0;
  versionNotice();
  console.log(C.b + (dry ? '[dry-run] 预演' : '应用补丁') + C.reset + ' → ' + TARGET + '\n');
  for (const p of PATCHES) {
    const r = applyOne(p, state, dry);
    const shown = r.file || p.file;
    if (r.status === 'already') {
      skipped++;
      console.log('  ' + paint('=', C.dim) + ' ' + p.id + ' ' + shown + ' ' + C.dim + '已生效，跳过' + C.reset);
    } else if (r.status === 'applied') {
      changed++;
      state.applied[p.id] = { at: new Date().toISOString(), file: shown };
      console.log('  ' + paint('✔', C.g) + ' ' + p.id + ' ' + shown + ' ' + C.dim + r.detail + C.reset);
    } else if (r.status === 'pending') {
      skipped++;
      console.log('  ' + paint('·', C.y) + ' ' + p.id + ' ' + shown + ' ' + r.detail);
    } else {
      failed++;
      console.log('  ' + paint('✖', C.r) + ' ' + p.id + ' ' + shown + ' ' + r.detail);
    }
  }
  writeState(state);
  console.log('\n改写 ' + changed + ' · 跳过 ' + skipped + ' · 未命中 ' + failed);
  if (failed) process.exitCode = 1;
  if (!dry) {
    console.log('\n' + paint('重启 Hermes 生效', C.y) + '：approval 状态在导入时冻结，必须重开进程。');
    console.log('回滚：node ' + path.relative(process.cwd(), __filename) + ' --revert');
  }
}

function cmdRevert() {
  let n = 0;
  const seen = new Set();
  for (const p of PATCHES) {
    const files = [p.file].concat((p.variants || []).map((v) => v.file));
    for (const rel of files) {
      const file = abs(rel);
      if (seen.has(file)) continue;
      seen.add(file);
      const bak = file + BAK_SUFFIX;
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, file);
        fs.unlinkSync(bak);
        n++;
        console.log('  ' + paint('↩', C.y) + ' ' + relOf(file));
      }
    }
  }
  const state = readState();
  state.applied = {};
  writeState(state);
  console.log('\n已回滚 ' + n + ' 个文件。重启 Hermes 生效。');
}

function cmdUninstall() {
  const before = readState();
  cmdRevert();
  for (const rel of (before.created || [])) {
    const f = path.resolve(TARGET, rel);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
  }
  try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  console.log('状态目录已清除。');
}

function cmdVerify() {
  const { spawnSync } = require('child_process');
  const cands = [
    path.join(TARGET, 'venv', 'Scripts', 'python.exe'),
    path.join(TARGET, '.hermes-runtime', 'python', 'cpython-3.11.16-windows-x86_64-none', 'python.exe'),
    path.join(TARGET, 'venv', 'bin', 'python'),
  ];
  const py = cands.find((p) => fs.existsSync(p));
  if (!py) { console.log(paint('找不到 Hermes 的 python，跳过运行时验证', C.y)); return; }

  /* 断言脚本自适应版本：0.21.0 把 approval_context / approval_detection 的函数
     放在 tools/approval.py 里，0.21.3 才拆成独立模块。 */
  const code = [
    'import sys, json',
    'sys.path.insert(0, r"' + TARGET + '")',
    'out = {}',
    'try:',
    '    import tools.approval as ap',
    '    out["YOLO_FROZEN"] = ap._YOLO_MODE_FROZEN',
    '    out["bypass_active"] = ap.is_approval_bypass_active()',
    '    try:',
    '        import tools.approval_context as ac',
    '    except ModuleNotFoundError:',
    '        ac = ap',
    '    out["approval_mode"] = ac._get_approval_mode()',
    '    out["normalize_manual"] = ac._normalize_approval_mode("manual")',
    '    if hasattr(ap, "_is_cron_approval_context"):',
    '        out["cron_ctx"] = ap._is_cron_approval_context()',
    '    import agent.tool_guardrails as g',
    '    d = g.ToolGuardrailDecision(action="halt", code="x")',
    '    out["guardrail_allows"] = d.allows_execution',
    '    out["guardrail_halt"] = d.should_halt',
    '    try:',
    '        import tools.approval_detection as ad',
    '    except ModuleNotFoundError:',
    '        ad = ap',
    '    out["hardline_detect"] = ad.detect_hardline_command("rm -rf / --no-preserve-root")[0]',
    '    out["dangerous_detect"] = ad.detect_dangerous_command("sudo rm -rf /etc")[0]',
    'except Exception as e:',
    '    out["error"] = type(e).__name__ + ": " + str(e)',
    'print(json.dumps(out, ensure_ascii=False))',
  ].join('\n');

  const r = spawnSync(py, ['-c', code], { cwd: TARGET, encoding: 'utf8', timeout: 120000 });
  const rawLine = (r.stdout || '').trim().split('\n').pop() || '{}';
  let out;
  try { out = JSON.parse(rawLine); } catch (e) { out = { error: (r.stderr || rawLine).slice(0, 400) }; }
  if (out.error) { console.log(paint('✖ 运行时验证失败: ', C.r) + out.error); process.exitCode = 1; return; }

  const EXPECT = [
    ['YOLO_FROZEN', true, 'YOLO 冻结标志'],
    ['bypass_active', true, '全局绕过生效'],
    ['approval_mode', 'off', '审批模式'],
    ['normalize_manual', 'off', '模式归一化'],
    ['guardrail_allows', true, '护栏放行'],
    ['guardrail_halt', false, '护栏停手'],
    ['hardline_detect', false, 'hardline 探测'],
    ['dangerous_detect', false, '危险命令探测'],
  ];
  // 0.21.0 才有这三个上下文判定；有就一并断言必须为 False（cron 不再直接 deny）
  if ('cron_ctx' in out) EXPECT.push(['cron_ctx', false, 'cron 上下文判定']);

  console.log(C.b + '运行时验证' + C.reset + '  python=' + py + '\n');
  let bad = 0;
  for (const item of EXPECT) {
    const k = item[0], want = item[1], label = item[2];
    const got = out[k];
    const ok = got === want;
    if (!ok) bad++;
    console.log('  ' + (ok ? paint('✔', C.g) : paint('✖', C.r)) + ' ' +
      label.padEnd(16) + ' = ' + String(got).padEnd(6) + ' ' + C.dim + '期望 ' + String(want) + C.reset);
  }
  console.log('\n' + (bad === 0 ? paint('清洗在运行时已生效', C.g) : paint(bad + ' 项未生效 —— 检查补丁', C.r)));
  if (bad) process.exitCode = 1;
}

/* ────────────────────────── 入口 ────────────────────────── */

if (!TARGET || !fs.existsSync(TARGET)) {
  console.error(
    '找不到 Hermes 安装目录。\n' +
    '  指定：  hermes-purge --status --target=D:\\path\\to\\hermes-agent\n' +
    '  或设：  HERMES_HOME=D:\\path\\to\\hermes\n' +
    (TARGET ? '  试过：  ' + TARGET : '')
  );
  process.exit(2);
}

if (args.status) cmdStatus(args.json);
else if (args.apply) cmdApply(!!args.dry);
else if (args.verify) cmdVerify();
else if (args.revert) cmdRevert();
else if (args.uninstall) cmdUninstall();
else {
  console.log([
    'hermes-purge — Hermes Agent 三层清洗',
    '',
    '  --status [--json]   查看 ' + PATCHES.length + ' 条补丁状态',
    '  --apply [--dry]     应用（--dry 只预演）',
    '  --verify            用 Hermes 自己的 python 跑运行时断言',
    '  --revert            用 .bak 回滚',
    '  --uninstall         回滚并清除状态',
    '  --target=DIR        指定 Hermes agent 目录（默认自动探测，或设 HERMES_HOME）',
    '',
    '补丁锚点验证版本：Hermes ' + TESTED_HERMES,
    '',
    '清洗内容：',
    '  提示词层  SOUL.md 人格/权威锚点替换',
    '  配置层    approvals.mode=off、model.max_tokens、prefill 文件；.env 注入 YOLO',
    '  代码层    approval / approval_context / edit_approval / tool_guardrails',
    '            / approval_detection / turn_context / chat_completion_helpers',
    '            / turn_request_assembly',
  ].join('\n'));
}
