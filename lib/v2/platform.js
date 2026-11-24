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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';

/* ───────────── 子进程：Windows 上 .cmd/.bat 不能直接 spawn ───────────── */

/**
 * Windows 上 spawnSync 直接执行 .cmd/.bat 会被 Node 拦下（≥20 抛 EINVAL，
 * 见 CVE-2024-27980 的修复）。pyenv-win / nvm / npm 的 `python3.bat`、`pip.cmd`
 * 全是这种 shim，于是「解释器没启动」被上游误报成「助手输出为空」「status 为 null」。
 * 统一入口：.cmd/.bat 交给 cmd.exe /d /s /c 执行，其余直连，都不经 shell。
 */
function quoteWin(s) {
  const t = String(s);
  if (!/[\s"&|<>^()%!]/.test(t)) return t;
  return '"' + t.replace(/"/g, '""') + '"';
}

function spawnAny(cmd, args, opts) {
  const o = Object.assign({ windowsHide: true, encoding: 'utf8' }, opts || {});
  const list = args || [];
  const ext = isWin ? path.extname(String(cmd || '')).toLowerCase() : '';
  if (isWin && (ext === '.bat' || ext === '.cmd')) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    const line = [quoteWin(cmd)].concat(list.map(quoteWin)).join(' ');
    // /s = 只剥最外层引号；windowsVerbatimArguments = 别让 Node 再包一次引号
    return spawnSync(comspec, ['/d', '/s', '/c', '"' + line + '"'],
      Object.assign({}, o, { windowsVerbatimArguments: true }));
  }
  return spawnSync(cmd, list, o);
}

/** python 子进程的环境：强制 UTF-8，避免 cp936 把中文路径 / JSON 打成乱码 */
function pyEnv(extra) {
  return Object.assign({}, process.env, {
    PYTHONIOENCODING: 'utf-8:replace',
    PYTHONUTF8: '1',
  }, extra || {});
}

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

/**
 * 解释器候选列表（按优先级）。
 *   hard=true  → 项目自己的 venv / PY 显式指定：存在即用，不 probing
 *               （测试会放空文件占位，探一下就废了）
 *   hard=false → PATH 上的：必须真能跑 python 才认，否则 Microsoft Store 的
 *               假 python.exe、坏掉的 py.exe 会把人骗走
 */
/* ───────────── pm 安装布局（代码根与 venv 分离）─────────────
 *
 * pm 装的 Hermes 长这样（issue #15 / #1）：
 *   <LOCALAPPDATA>\hermes\hermes-agent                 ← 代码根（editable install）
 *   <LOCALAPPDATA>\hermes\installs\<id>\facts.json      ← packages.venv.environment 指真实 venv
 *   <LOCALAPPDATA>\hermes\installs\<id>\environments\<hash>\venv\Scripts\python.exe
 * 旧的候选表只认「venv 和代码根同目录」，于是 findPython 返回 null、sitePackages 返回 []，
 * shim 恒报 no-site-packages、verify 直接短路 —— 两个症状同一个原因。
 *
 * 安全边界：只在 root 确实位于某个 hermes home 之下时才扫，避免把别处的 venv 认成宿主
 * （否则临时目录里的测试会被真机的 venv 污染）。
 */

function hermesHomes() {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!out.some((x) => x === abs)) out.push(abs);
  };
  if (process.env.HERMES_HOME) push(process.env.HERMES_HOME);
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'hermes'));
  try { push(path.join(os.homedir(), '.hermes')); } catch (e) { /* 忽略 */ }
  return out;
}

function isUnder(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 这个代码根属于哪个 hermes home（不属于任何 home 返回 null） */
function pmHomeFor(root) {
  if (!root) return null;
  for (const home of hermesHomes()) if (isUnder(root, home)) return home;
  return null;
}

/**
 * pm 布局下的 venv 目录列表。
 * 先读 installs/<id>/facts.json 的 packages.venv.environment（权威），
 * 再兜底扫 environments/<hash>/venv（facts 缺失或字段改名也能用）。
 */
function pmVenvsFor(root) {
  const home = pmHomeFor(root);
  if (!home) return [];
  const base = path.join(home, 'installs');
  let installs = [];
  try { installs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { return []; }
  const found = [];
  const pushVenv = (p) => {
    if (!p || typeof p !== 'string') return;
    const abs = path.resolve(p);
    if (found.includes(abs)) return;
    try { if (fs.existsSync(abs)) found.push(abs); } catch (e) { /* 忽略 */ }
  };
  for (const inst of installs) {
    const dir = path.join(base, inst.name);
    try {
      const facts = JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8'));
      const v = facts && facts.packages && facts.packages.venv;
      pushVenv(v && (v.environment || v.path || v.root));
    } catch (e) { /* 没有 / 坏 json：走下面的兜底 */ }
    const envsDir = path.join(dir, 'environments');
    let envs = [];
    try { envs = fs.readdirSync(envsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { envs = []; }
    for (const e of envs) pushVenv(path.join(envsDir, e.name, 'venv'));
  }
  return found;
}

/** <venv>/Scripts/python.exe → <venv>；<venv>/bin/python → <venv> */
function venvOf(py) {
  if (!py) return null;
  const d = path.dirname(String(py));
  const base = path.basename(d).toLowerCase();
  return (base === 'scripts' || base === 'bin') ? path.dirname(d) : null;
}

/** 一个 venv 目录里的 site-packages（Windows=Lib，POSIX=lib/pythonX.Y） */
function sitePackagesOfVenv(venv, out) {
  const add = (p) => { try { if (fs.existsSync(p) && !out.includes(p)) out.push(p); } catch (e) { /* 忽略 */ } };
  add(path.join(venv, 'Lib', 'site-packages'));
  const lib = path.join(venv, 'lib');
  let dirs = [];
  try { dirs = fs.readdirSync(lib); } catch (e) { dirs = []; }
  for (const d of dirs) {
    if (!d.startsWith('python')) continue;
    add(path.join(lib, d, 'site-packages'));
  }
  return out;
}

function pythonCandidates(root) {
  const out = [];
  const add = (p, hard) => {
    if (!p) return;
    if (out.some((x) => x.p === p)) return;
    out.push({ p, hard: !!hard });
  };
  if (process.env.PY) add(process.env.PY, true);
  if (root) {
    for (const c of [
      path.join(root, 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'bin', 'python'),
      path.join(root, '.venv', 'Scripts', 'python.exe'),
      path.join(root, '.venv', 'bin', 'python'),
      path.join(root, '.hermes-runtime', 'python', 'cpython-3.11.16-windows-x86_64-none', 'python.exe'),
    ]) add(c, true);
    // 兜底：配置根下的 venv（代码根常是 <home>/hermes-agent）
    const parent = path.resolve(root, '..');
    add(path.join(parent, 'venv', 'bin', 'python'), true);
    add(path.join(parent, 'venv', 'Scripts', 'python.exe'), true);
    // pm 布局：venv 在 installs/<id>/environments/<hash>/venv，和代码根不在一层
    for (const v of pmVenvsFor(root)) {
      add(path.join(v, 'Scripts', 'python.exe'), true);
      add(path.join(v, 'bin', 'python'), true);
    }
  }
  // Windows 上 python 排在 python3 前面：pyenv-win 的 python3 只有 .bat 代理
  for (const name of (isWin ? ['python', 'python3', 'py'] : ['python3', 'python'])) add(which(name), false);
  return out;
}

const pyProbeCache = new Map();

/** 这个解释器真能跑 python 3 吗（结果按路径缓存） */
function probePython(py) {
  if (!py) return false;
  if (pyProbeCache.has(py)) return pyProbeCache.get(py);
  let ok = false;
  try {
    const r = spawnAny(py, ['-c', 'import sys;print("py-ok",sys.version_info[0])'],
      { timeout: 20000, env: pyEnv() });
    ok = !r.error && r.status === 0 && /py-ok 3/.test(r.stdout || '');
  } catch (e) { ok = false; }
  pyProbeCache.set(py, ok);
  return ok;
}

function findPython(root) {
  const cands = pythonCandidates(root);
  const exists = (c) => { try { return fs.existsSync(c.p); } catch (e) { return false; } };
  for (const c of cands) if (c.hard && exists(c)) return c.p;
  const sys = cands.filter((c) => !c.hard && exists(c));
  for (const c of sys) if (probePython(c.p)) return c.p;
  return (sys[0] && sys[0].p) || null;
}

/** 需要「保证能 spawn 成功」的场景用这个：全部候选都走 probing */
function pickPython(root) {
  for (const c of pythonCandidates(root)) {
    try { if (!fs.existsSync(c.p)) continue; } catch (e) { continue; }
    if (probePython(c.p)) return c.p;
  }
  return findPython(root);
}

const EXT_RANK = { '.com': 0, '.exe': 1, '.bat': 2, '.cmd': 3 };

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const base = String(cmd || '');
  const names = [];
  if (isWin) {
    if (/\.(?:com|exe|bat|cmd)$/i.test(base)) {
      names.push(base);
    } else {
      // .COM/.EXE 优先：真二进制能直接 spawn，.bat/.cmd 只是代理
      const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        .map((e) => e.toLowerCase())
        .sort((a, b) => (EXT_RANK[a] == null ? 9 : EXT_RANK[a]) - (EXT_RANK[b] == null ? 9 : EXT_RANK[b]));
      for (const e of exts) names.push(base + e);
      names.push(base);
    }
  } else {
    names.push(base);
  }
  for (const d of dirs) {
    for (const n of names) {
      const f = path.join(d, n);
      try { if (fs.existsSync(f) && fs.statSync(f).isFile()) return f; } catch (e) { /* 忽略 */ }
    }
  }
  return null;
}

/**
 * 宿主 venv 的 site-packages。三路来源，按可信度排：
 *   1. root 下的 venv/.venv（co-located 布局，老路径，行为不变）
 *   2. 传进来的 py（PY= / findPython 的结果）所在的 venv —— issue 里点名「PY 指对了也不读 PY」
 *   3. pm 布局的 installs/<id>/.../venv
 * 只在前一路什么都没找到时才走后面，避免把无关 venv 混进来。
 */
function sitePackages(root, py) {
  const out = [];
  if (root) {
    const venv = path.join(root, 'venv');
    const win = path.join(venv, 'Lib', 'site-packages');
    if (fs.existsSync(win)) out.push(win);
    const lib = path.join(venv, 'lib');
    let dirs = [];
    try { dirs = fs.readdirSync(lib); } catch (e) { dirs = []; }
    for (const d of dirs) {
      if (!d.startsWith('python')) continue;
      const sp = path.join(lib, d, 'site-packages');
      if (fs.existsSync(sp)) out.push(sp);
    }
    if (!out.length) sitePackagesOfVenv(path.join(root, '.venv'), out);
  }
  if (!out.length && py) {
    const v = venvOf(py);
    if (v) sitePackagesOfVenv(v, out);
  }
  if (!out.length && root) {
    for (const v of pmVenvsFor(root)) sitePackagesOfVenv(v, out);
  }
  return out;
}

/**
 * 宿主 Hermes 版本。以前只读 pyproject 的 version —— pm/editable 装法里那行是 `0.0.0`，
 * 于是外部用户看到「目标 Hermes 版本 0.0.0，主锚验证于 0.21.3」，一脸问号。
 * 现在按可信度依次找：pyproject（0.0.0 视为占位）→ hermes_agent/__init__.py →
 * hermes_constants.py → VERSION 文件 → pm facts.json → ~/.hermes/version。
 * 全都读不到返回 null（调用方显示 unknown，而不是编一个 0.0.0 出来）。
 */
function hermesVersion(root) {
  if (!root) return null;
  const ok = (v) => (v && /^\d+\.\d+/.test(v) && !/^0\.0\.0$/.test(v)) ? v : null;
  const grab = (file, re) => {
    try { const m = fs.readFileSync(file, 'utf8').match(re); return m ? m[1] : null; } catch (e) { return null; }
  };
  // install-stamp.json 是宿主自己的权威身份（hermes_cli/version_info.py 也按它来）：
  // baseVersion 有值用 baseVersion，否则 displayVersion（git 源码装是 "git.<sha>[.dirty]"）。
  const stamp = () => {
    for (const dir of [root, path.resolve(root, '..')].concat(hermesHomes())) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, 'install-stamp.json'), 'utf8'));
        const base = j && j.baseVersion;
        if (base && /^\d+\.\d+/.test(base)) return base;
        const disp = j && (j.displayVersion || j.tag);
        if (disp && typeof disp === 'string') return disp;
      } catch (e) { /* 没有就下一个 */ }
    }
    return null;
  };
  const tries = [
    stamp,
    () => ok(grab(path.join(root, 'pyproject.toml'), /^version\s*=\s*["']([^"']+)["']/m)),
    () => ok(grab(path.join(root, 'hermes_agent', '__init__.py'), /__version__\s*=\s*["']([^"']+)["']/)),
    () => ok(grab(path.join(root, 'hermes_constants.py'), /__version__\s*=\s*["']([^"']+)["']/)),
    () => ok(grab(path.join(root, 'VERSION'), /^\s*(\S+)\s*$/m)),
    () => ok(grab(path.join(root, '.hermes', 'version'), /^\s*(\S+)\s*$/m)),
    () => {
      // pm 装法：facts.json 里常带 version
      for (const v of pmVenvsFor(root)) {
        const facts = path.join(path.dirname(path.dirname(v)), '..', 'facts.json');
        const got = ok(grab(facts, /"version"\s*:\s*"([^"]+)"/));
        if (got) return got;
      }
      return null;
    },
    () => {
      for (const home of hermesHomes()) {
        const got = ok(grab(path.join(home, 'version'), /^\s*(\S+)\s*$/m));
        if (got) return got;
      }
      return null;
    },
  ];
  for (const f of tries) {
    try { const v = f(); if (v) return v; } catch (e) { /* 忽略 */ }
  }
  return null;
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

/**
 * 全树符号索引：一次遍历把「符号名 → 定义位置」建好。
 *
 * 为什么不是「每个符号扫一遍全树」：cap 从 31 涨到 64 之后，status 里 45 条 AST
 * cap 各扫一遍 700 个 .py 文件，光这里就要 20s+ —— 用户敲 purge status 等半分钟
 * 是不可接受的。改成一趟正则建表，之后 O(1)。
 *
 * 语义与原来逐符号扫描一致：每个文件同一个符号只记第一次出现的定义，
 * 同一符号最多保留 6 个文件（调用方只取 hits[0]）。
 */
const symbolIndexCache = new Map();
const RE_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;
const RE_CLS = /^(\s*)class\s+(\w+)\b/;
const RE_ASG = /^(\s*)(\w+)\s*(?::[^=]+)?=\s*/;

function symbolIndex(root) {
  if (symbolIndexCache.has(root)) return symbolIndexCache.get(root);
  const index = new Map();
  const push = (name, hit) => {
    const list = index.get(name);
    if (!list) { index.set(name, [hit]); return; }
    if (list.length >= 6) return;
    if (list.some((h) => h.file === hit.file)) return;  // 同文件只记第一次
    list.push(hit);
  };
  for (const file of listPyFiles(root)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/\r$/, '');
      if (!raw) continue;
      let m = raw.match(RE_DEF);
      if (m) { push(m[2], { file, line: i + 1, indent: m[1].length, kind: 'def' }); continue; }
      m = raw.match(RE_CLS);
      if (m) { push(m[2], { file, line: i + 1, indent: m[1].length, kind: 'class' }); continue; }
      m = raw.match(RE_ASG);
      if (m && m[1].length === 0) {
        // 模块级赋值：只认顶格，函数体里的局部变量不算定义
        push(m[2], { file, line: i + 1, indent: 0, kind: 'assign' });
      }
    }
  }
  symbolIndexCache.set(root, index);
  return index;
}

/**
 * 按符号名定位定义行，不假设文件布局。
 * 返回 [{file, line, indent, kind}] —— 优先 def/class，其次模块级赋值。
 */
function findSymbol(root, symbol) {
  return symbolIndex(root).get(symbol) || [];
}

module.exports = {
  isWin, SKIP_DIRS,
  readText, writeText,
  spawnAny, pyEnv,
  findPython, pickPython, probePython, pythonCandidates, which, sitePackages,
  pmVenvsFor, pmHomeFor, venvOf, sitePackagesOfVenv, hermesVersion,
  listPyFiles, findSymbol,
};