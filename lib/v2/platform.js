'use strict';
/**
 * lib/v2/platform.js —— 跨平台底座
 *
 * 目标：macOS / Linux / Windows 同一份代码跑通。
 * 规矩：
 *   1. 所有路径用 path.join，绝不手写分隔符
 *   2. 换行按文件现状保留（Windows 上 .py 常见 CRLF，改完必须还是 CRLF）
 *   3. 只调 fs API，不调 sed/awk/rm；子进程一律 spawnSync(数组参数)，不经 shell
 *   4. chmod 只在非 Windows 上做
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';

/** 目录遍历时永远跳过的重型目录 */
const SKIP_DIRS = new Set(['.git', 'venv', '.venv', 'node_modules', '__pycache__',
  '.mypy_cache', '.pytest_cache', 'dist', 'build', '.tox', 'site-packages']);

/* ───────────── 文本读写：保留 BOM 与换行 ───────────── */

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  let bom = '';
  if (text.charCodeAt(0) === 0xfeff) { bom = '\ufeff'; text = text.slice(1); }
  // 以文件里第一个换行为准（没有则按平台默认）
  const m = text.match(/\r\n|\n/);
  const eol = m ? m[0] : (isWin ? '\r\n' : '\n');
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { text, bom, eol: crlf > lf ? '\r\n' : (lf > 0 ? '\n' : eol) };
}

/** 原子写：同目录临时文件 + rename（Windows 上 rename 覆盖已存在文件也成立，Node ≥14） */
function writeText(file, text, opts) {
  const o = opts || {};
  const bom = o.bom || '';
  const eol = o.eol || (isWin ? '\r\n' : '\n');
  let out = text;
  // 把「内容里的 \n」统一成目标 eol；已经 CRLF 的不重复加 \r
  out = out.replace(/\r\n/g, '\n');
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  const tmp = file + '.purge-tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, bom + out, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows 上目标被占用时会 EPERM：退化为覆盖写
    try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
    fs.writeFileSync(file, bom + out, 'utf8');
  }
}

/* ───────────── venv / python 发现 ───────────── */

function findPython(root) {
  const cands = [
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'bin', 'python'),
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    path.join(root, '.hermes-runtime', 'python', 'cpython-3.11.16-windows-x86_64-none', 'python.exe'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  // 兜底：配置根下的 venv（代码根常是 <home>/hermes-agent）
  const parent = path.resolve(root, '..');
  for (const c of [path.join(parent, 'venv', 'bin', 'python'),
    path.join(parent, 'venv', 'Scripts', 'python.exe')]) {
    if (fs.existsSync(c)) return c;
  }
  for (const name of (isWin ? ['python', 'py'] : ['python3', 'python'])) {
    const w = which(name);
    if (w) return w;
  }
  return null;
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const f = path.join(d, cmd + ext);
      try { if (fs.existsSync(f)) return f; } catch (e) { /* 忽略 */ }
    }
  }
  return null;
}

/** venv 的 site-packages（Windows=Lib/site-packages，POSIX=lib/pythonX.Y/site-packages） */
function sitePackages(root) {
  const venv = path.join(root, 'venv');
  const out = [];
  const win = path.join(venv, 'Lib', 'site-packages');
  if (fs.existsSync(win)) out.push(win);
  const lib = path.join(venv, 'lib');
  if (fs.existsSync(lib)) {
    for (const d of fs.readdirSync(lib)) {
      if (!d.startsWith('python')) continue;
      const sp = path.join(lib, d, 'site-packages');
      if (fs.existsSync(sp)) out.push(sp);
    }
  }
  return out;
}

/* ───────────── 源码遍历 / 符号定位 ───────────── */

/** 深度优先列出 .py 文件（跳过重型目录） */
function listPyFiles(root, limit) {
  const out = [];
  const max = limit || 20000;
  const walk = (dir) => {
    if (out.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (out.length >= max) return;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(path.join(dir, ent.name));
      } else if (ent.isFile() && ent.name.endsWith('.py')) {
        out.push(path.join(dir, ent.name));
      }
    }
  };
  walk(root);
  return out;
}

const symbolCache = new Map();

/**
 * 按符号名定位定义行，不假设文件布局。
 * 返回 [{file, line, indent, kind}] —— 优先 def/class，其次模块级赋值。
 */
/* 符号索引：findSymbol 每次都要把整棵树的 .py 读一遍（4937 个文件 / 95MB ≈ 160ms/次），
 * 而 status 一次要查 ~20 个符号 → 秒级。这里改成「补丁会碰到的目录」建一次索引，
 * 之后全命中缓存；没命中再退回全树扫描（语义不变）。 */
const INDEX_DIRS = ['agent', 'tools', 'hermes_cli', 'acp_adapter'];
const indexCache = new Map();   // root → Map(name → hits[])

// 必须和 listPyFiles 用同一套文件集合与遍历顺序，否则「索引命中的文件」可能
// 不是「全树扫描会命中的文件」—— 实测就因此让 C06/C10 退化（31 → 29）。
function listIndexFiles(root) {
  // 补丁只会落在这些目录里；先扫它们（24MB vs 全树 95MB），没命中的符号再退回全树扫描。
  // 用 HERMES_PURGE_INDEX=full 可切回全树（对照用）。
  if (process.env.HERMES_PURGE_INDEX === 'full') return listPyFiles(root);
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(abs);
      } else if (e.name.endsWith('.py')) {
        out.push(abs);
      }
    }
  };
  for (const d of INDEX_DIRS) walk(path.join(root, d));
  return out;
}

function buildIndex(root) {
  const map = new Map();
  const push = (name, hit) => {
    if (!name) return;
    const arr = map.get(name);
    if (arr) { if (arr.length < 6) arr.push(hit); } else map.set(name, [hit]);
  };
  const reDefAll = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
  const reClsAll = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
  const reAsgAll = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*/;
  for (const file of listIndexFiles(root)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const seen = new Set();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/\r$/, '');
      let m = raw.match(reDefAll);
      if (m && !seen.has(m[2])) { seen.add(m[2]); push(m[2], { file, line: i + 1, indent: m[1].length, kind: 'def' }); continue; }
      m = raw.match(reClsAll);
      if (m && !seen.has(m[2])) { seen.add(m[2]); push(m[2], { file, line: i + 1, indent: m[1].length, kind: 'class' }); continue; }
      m = raw.match(reAsgAll);
      if (m && m[1].length === 0 && !seen.has(m[2])) { seen.add(m[2]); push(m[2], { file, line: i + 1, indent: 0, kind: 'assign' }); }
    }
  }
  return map;
}

function indexFor(root) {
  let idx = indexCache.get(root);
  if (!idx) { idx = buildIndex(root); indexCache.set(root, idx); }
  return idx;
}

function findSymbol(root, symbol) {
  const key = root + '::' + symbol;
  if (symbolCache.has(key)) return symbolCache.get(key);

  // 先查索引（覆盖 agent/ tools/ hermes_cli/ acp_adapter/）
  const hit = indexFor(root).get(symbol);
  if (hit && hit.length) { symbolCache.set(key, hit); return hit; }

  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reDef = new RegExp('^(\\s*)(?:async\\s+)?def\\s+' + esc + '\\s*\\(');
  const reCls = new RegExp('^(\\s*)class\\s+' + esc + '\\b');
  const reAsg = new RegExp('^(\\s*)' + esc + '\\s*(?::[^=]+)?=\\s*');
  const hits = [];
  for (const file of listPyFiles(root)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    if (!text.includes(symbol)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/\r$/, '');
      let m = raw.match(reDef);
      if (m) { hits.push({ file, line: i + 1, indent: m[1].length, kind: 'def' }); break; }
      m = raw.match(reCls);
      if (m) { hits.push({ file, line: i + 1, indent: m[1].length, kind: 'class' }); break; }
      m = raw.match(reAsg);
      if (m && m[1].length === 0) { hits.push({ file, line: i + 1, indent: 0, kind: 'assign' }); break; }
    }
    if (hits.length >= 6) break;
  }
  symbolCache.set(key, hits);
  return hits;
}

module.exports = {
  isWin, SKIP_DIRS,
  readText, writeText,
  findPython, which, sitePackages,
  listPyFiles, findSymbol,
};