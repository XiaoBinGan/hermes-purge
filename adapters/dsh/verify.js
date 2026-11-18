'use strict';
/**
 * adapters/dsh/verify.js —— DSH adapter 的验证
 *
 *   L1 静态：node --check（JS）/ JSON.parse（json）/ 结构检查（yml，零依赖不做完整解析）
 *   L2 断言：每条 cap 的 asserts 在一个 node 进程里跑（读目标树，返回 ok + detail）
 *   L3 端到端：需要真机 DSH —— 没有，如实返回不可用，不假装通过
 *
 * L2 的口径：status = drifted 的 cap 跳过（环境缺件，例如夹具没有 headless profile），
 * 跳过会记成 ok:true + skipped 明细 —— 不是「通过」，报告里必须点出来。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function abs(target, rel) { return path.resolve(target, rel); }

/* ───────────── L1 ───────────── */

/** 极简 YAML 结构检查：不解析，只抓「明显写坏」的（tab 缩进 / 引号不闭合 / 行不是键值或列表） */
function checkYamlLite(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const problems = [];
  lines.forEach((line, i) => {
    if (/\t/.test(line)) problems.push('L' + (i + 1) + ' tab 缩进');
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const quotes = (t.match(/'/g) || []).length;
    const dquotes = (t.match(/"/g) || []).length;
    if (quotes % 2 || dquotes % 2) problems.push('L' + (i + 1) + ' 引号不闭合');
    if (/^\[\]$/.test(t)) return;
    if (/^-\s+\S/.test(t)) return;
    if (/^[A-Za-z0-9_.@/-]+:(\s.*)?$/.test(t)) return;
    problems.push('L' + (i + 1) + ' 不像 YAML 行: ' + t.slice(0, 40));
  });
  return problems;
}

function l1Static(target, files) {
  const checks = [];
  for (const rel of files) {
    const file = abs(target, rel);
    if (!fs.existsSync(file)) continue;
    if (/\.(c|m)?js$/.test(rel)) {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      checks.push({ name: 'node --check ' + rel, ok: r.status === 0, detail: (r.stderr || '').trim().split('\n').slice(0, 2).join(' ') });
    } else if (/\.json$/.test(rel)) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        checks.push({ name: 'json ' + rel, ok: true, detail: 'parse ok' });
      } catch (e) {
        checks.push({ name: 'json ' + rel, ok: false, detail: e.message.slice(0, 120) });
      }
    } else if (/\.ya?ml$/i.test(rel)) {
      const problems = checkYamlLite(file);
      checks.push({ name: 'yaml ' + rel, ok: problems.length === 0, detail: problems.slice(0, 3).join('; ') || '结构 ok' });
    }
  }
  return { level: 'L1', checks, ok: checks.every((c) => c.ok) };
}

/* ───────────── L2 ───────────── */

const PRELUDE = `
'use strict';
const fs = require('fs');
const path = require('path');
const T = process.argv[2];
function p(rel) { return path.resolve(T, rel); }
function read(rel) { return fs.readFileSync(p(rel), 'utf8'); }
function exists(rel) { return fs.existsSync(p(rel)); }
function has(rel, needle) { return exists(rel) && read(rel).indexOf(needle) >= 0; }
function hasId(rel, id) { return exists(rel) && new RegExp('^\\\\s*-\\\\s+id:\\\\s*' + id + '\\\\s*$', 'm').test(read(rel)); }
function jsonGet(rel, dot) {
  try {
    let cur = JSON.parse(read(rel));
    for (const k of String(dot).split('.')) {
      if (cur === null || typeof cur !== 'object' || !(k in cur)) return undefined;
      cur = cur[k];
    }
    return cur;
  } catch (e) { return undefined; }
}
function grep(rel, re) { if (!exists(rel)) return null; const m = read(rel).match(new RegExp(re, 'm')); return m ? m[0] : null; }
`;

/** 跑所有 cap 的断言；ctx.probe(cap).status 决定是否跳过 */
function l2Assertions(target, capList, ctx) {
  const cases = [];
  const skipped = [];
  for (const cap of capList) {
    const st = ctx && typeof ctx.probe === 'function' ? ctx.probe(cap) : { status: 'pending' };
    if (st.status === 'drifted') {
      skipped.push(cap.id);
      continue;
    }
    for (const a of cap.asserts || []) {
      cases.push({ id: cap.id, name: a.name, code: a.code });
    }
  }

  const checks = [];
  if (cases.length) {
    const script = PRELUDE + '\nconst CASES = ' + JSON.stringify(cases) + ';\n' +
      'const out = CASES.map(function (c) {\n' +
      '  try {\n' +
      '    const fn = new Function("read", "exists", "has", "hasId", "jsonGet", "grep", c.code);\n' +
      '    const r = fn(read, exists, has, hasId, jsonGet, grep);\n' +
      '    return { id: c.id, name: c.name, ok: !!(r && r.ok), detail: String((r && r.detail) || "") };\n' +
      '  } catch (e) {\n' +
      '    return { id: c.id, name: c.name, ok: false, detail: "断言异常: " + e.message };\n' +
      '  }\n' +
      '});\n' +
      'process.stdout.write(JSON.stringify(out));\n';

    const tmp = path.join(os.tmpdir(), 'purge-dsh-assert-' + process.pid + '-' + Date.now() + '.js');
    fs.writeFileSync(tmp, script, 'utf8');
    let parsed = [];
    try {
      const r = spawnSync(process.execPath, [tmp, target], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
      try { parsed = JSON.parse((r.stdout || '[]').trim() || '[]'); } catch (e) {
        checks.push({ name: 'L2 断言脚本', ok: false, detail: ((r.stderr || '').trim() || 'no output').slice(0, 300) });
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    }
    for (const p of parsed) checks.push({ name: p.id + ' ' + p.name, ok: !!p.ok, detail: p.detail });
  }

  if (!checks.length && !skipped.length) {
    checks.push({ name: 'L2 断言', ok: false, detail: '没有可执行的断言' });
  }
  if (skipped.length) {
    checks.push({ name: 'L2 跳过（drifted）', ok: true, skipped: true, detail: skipped.join(',') + ' —— 环境缺件，未断言' });
  }
  return { level: 'L2', checks, ok: checks.every((c) => c.ok), skipped };
}

/* ───────────── L3 ───────────── */

function l3E2E(target, opts) {
  void target; void opts;
  return {
    level: 'L3',
    ok: false,
    checks: [{
      name: 'dsh 真机端到端',
      ok: false,
      detail: '未在真机 DSH 0.2 上跑过（本机无安装）：DSH adapter 目前是规格 + 结构验证',
    }],
  };
}

module.exports = { l1Static, l2Assertions, l3E2E, checkYamlLite };