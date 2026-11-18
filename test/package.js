'use strict';
/**
 * test/package.js —— 打包形态自检（不联网、不 npm install、不写仓库）
 *
 *   node test/package.js
 *
 * 覆盖：
 *   1) package.json 的 bin 三个入口都存在，且都能 node --check 通过
 *   2) npm pack --dry-run --json 的文件清单：该有的在，不该有的不在
 *   3) purge.cmd 存在且能调用 node
 *   4) 端到端：npm pack 出真 tgz → 解开 → node package/bin/purge.js --version
 *
 * 零依赖，跨平台：所有外部程序走 spawnSync 数组参数 + windowsHide，不用 shell 管道。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const PKG = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

/* ───────────── 子进程 / npm 解析 ───────────── */

function resolveNpm() {
  const cands = [];
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) cands.push(process.env.npm_execpath);
  const nodeDir = path.dirname(process.execPath);
  // POSIX：<prefix>/lib/node_modules/npm；Windows：<node 目录>/node_modules/npm
  cands.push(
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  );
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return { cmd: process.execPath, prefix: [c] }; } catch (e) { /* 继续找 */ }
  }
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

const NPM = resolveNpm();

function run(cmd, argv, opts) {
  const o = Object.assign({ encoding: 'utf8', windowsHide: true, timeout: 120000 }, opts || {});
  let r = spawnSync(cmd, argv, o);
  // Windows 上直接 spawn npm.cmd 在新版 Node 会 EINVAL；只有落到最后这个分支才用 shell
  if (r.error && (r.error.code === 'EINVAL' || r.error.code === 'ENOENT') && process.platform === 'win32') {
    r = spawnSync(cmd, argv, Object.assign({}, o, { shell: true }));
  }
  return r;
}

function runNpm(argv, opts) {
  return run(NPM.cmd, NPM.prefix.concat(argv), opts);
}

function npmJson(argv, opts) {
  const r = runNpm(argv, opts);
  const out = (r.stdout || '') + '';
  const a = out.indexOf('['), b = out.lastIndexOf(']');
  assert.ok(a >= 0 && b > a, 'npm 没有输出 JSON（status=' + r.status + '）：' + (out || r.stderr || r.error));
  return JSON.parse(out.slice(a, b + 1));
}

/* ───────────── 工作目录 ───────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-pkg-'));
const cleanup = [];
function onExit() {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }
  }
}
process.on('exit', onExit);

/* ───────────── 1. package.json / bin ───────────── */

console.log('\npackage.json 与 bin 入口');

t('package.json 能解析且 name/version 齐全', () => {
  assert.strictEqual(typeof PKG.name, 'string');
  assert.ok(/^\d+\.\d+\.\d+/.test(PKG.version), 'version 不像 semver：' + PKG.version);
});

t('engines.node 仍是 >=18', () => {
  assert.strictEqual(PKG.engines && PKG.engines.node, '>=18');
});

t('os 语义未被动过（win32/linux/darwin）', () => {
  assert.ok(Array.isArray(PKG.os));
  for (const p of ['win32', 'linux', 'darwin']) assert.ok(PKG.os.includes(p), '缺 ' + p);
});

t('bin 三入口都在 package.json 里', () => {
  assert.ok(PKG.bin && typeof PKG.bin === 'object');
  for (const k of ['purge', 'hp', 'hermes-purge']) {
    assert.ok(PKG.bin[k], '缺 bin.' + k);
    assert.ok(fs.existsSync(path.join(ROOT, PKG.bin[k])), 'bin.' + k + ' 指向的文件不存在：' + PKG.bin[k]);
  }
});

t('bin 三入口都能 node --check 通过', () => {
  for (const k of ['purge', 'hp', 'hermes-purge']) {
    const f = path.join(ROOT, PKG.bin[k]);
    const r = run(process.execPath, ['--check', f]);
    assert.strictEqual(r.status, 0, path.basename(f) + ' 语法检查失败：' + (r.stderr || r.error));
  }
});

t('purge 入口有 shebang', () => {
  const s = fs.readFileSync(path.join(ROOT, 'bin', 'purge.js'), 'utf8');
  assert.strictEqual(s.split('\n')[0].trim(), '#!/usr/bin/env node');
});

/* ───────────── 2. npm pack 清单 ───────────── */

console.log('\nnpm pack --dry-run 文件清单');

const dry = npmJson(['pack', '--dry-run', '--json'], { cwd: ROOT });
const listed = (dry[0] && dry[0].files ? dry[0].files : []).map((f) => f.path.split(path.sep).join('/'));

t('清单里该有的文件都在', () => {
  for (const f of ['bin/purge.js', 'lib/v2/caps.js', 'payload/SOUL.md', 'docs/design-v2.md', 'purge.cmd']) {
    assert.ok(listed.includes(f), '缺 ' + f);
  }
});

t('清单里没有运行时/依赖/临时产物', () => {
  const bad = listed.filter((f) =>
    /(^|\/)\.hermes-purge/.test(f) ||
    /(^|\/)node_modules(\/|$)/.test(f) ||
    /(^|\/)state(\/|$)/.test(f) ||
    /(^|\/)__pycache__(\/|$)/.test(f) ||
    /\.(tgz|log|tmp|bak)$/.test(f) ||
    /(^|\/)\.DS_Store$/.test(f) ||
    /(^|\/)\.runtime-prefill\.json$/.test(f)
  );
  assert.deepStrictEqual(bad, [], '不该被打进去的文件：' + bad.join(', '));
});

t('清单规模合理（≤ files 字段允许的范围）', () => {
  assert.ok(listed.length > 20, '文件数偏少：' + listed.length);
  assert.ok(listed.length < 200, '文件数偏多，可能漏了排除：' + listed.length);
});

t('package.json 的 files 覆盖了所有 bin 入口与启动器', () => {
  for (const k of ['purge', 'hp', 'hermes-purge']) {
    assert.ok(listed.includes(PKG.bin[k].replace(/^\.\//, '')), 'files 没带上 bin.' + k);
  }
  assert.ok(PKG.files.includes('purge.cmd'), 'files 里缺 purge.cmd');
});

/* ───────────── 3. purge.cmd ───────────── */

console.log('\nWindows 启动器');

t('purge.cmd 存在', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'purge.cmd')));
});

t('purge.cmd 走 node + %~dp0 相对定位', () => {
  const s = fs.readFileSync(path.join(ROOT, 'purge.cmd'), 'utf8');
  assert.ok(/@echo off/i.test(s), '缺 @echo off');
  assert.ok(/\bnode\b/i.test(s), '内容里没有 node');
  assert.ok(/%~dp0/.test(s), '没有用 %~dp0 定位脚本目录');
  assert.ok(/bin\\purge\.js/i.test(s), '没有指向 bin\\purge.js');
  assert.ok(/%\*/.test(s), '没有透传参数 %*');
});

/* ───────────── 4. 端到端：真 tgz ───────────── */

console.log('\n端到端打包（真 tgz → 解开 → 跑 --version）');

const packDest = path.join(tmp, 'pack');
fs.mkdirSync(packDest, { recursive: true });
const unpackDir = path.join(tmp, 'unpack');
cleanup.push(tmp);

let tgz = null;
t('npm pack 产出 tgz', () => {
  const j = npmJson(['pack', '--pack-destination=' + packDest, '--json'], { cwd: ROOT });
  const name = j[0] && j[0].filename;
  assert.ok(name, 'npm pack --json 没给出 filename');
  tgz = path.join(packDest, name);
  assert.ok(fs.existsSync(tgz), 'tgz 不存在：' + tgz);
  assert.ok(fs.statSync(tgz).size > 1024, 'tgz 太小：' + fs.statSync(tgz).size);
});

t('tgz 能解开', () => {
  assert.ok(tgz, '上一步没拿到 tgz');
  fs.mkdirSync(unpackDir, { recursive: true });
  const r = run('tar', ['-xzf', tgz, '-C', unpackDir]);
  assert.strictEqual(r.status, 0, 'tar 解包失败：' + (r.stderr || r.error));
  assert.ok(fs.existsSync(path.join(unpackDir, 'package', 'bin', 'purge.js')), '解开的包里没有 bin/purge.js');
});

t('解开的包能跑 --version，且版本号与 package.json 一致', () => {
  const entry = path.join(unpackDir, 'package', 'bin', 'purge.js');
  const r = run(process.execPath, [entry, '--version'], { cwd: path.join(unpackDir, 'package') });
  assert.strictEqual(r.status, 0, '--version 退出码 ' + r.status + '：' + (r.stderr || r.error));
  assert.strictEqual((r.stdout || '').trim(), PKG.version);
});

t('解开的包能跑 --help（不依赖本机 Hermes 安装）', () => {
  const entry = path.join(unpackDir, 'package', 'bin', 'purge.js');
  const r = run(process.execPath, [entry, '--help'], {
    cwd: path.join(unpackDir, 'package'),
    env: Object.assign({}, process.env, { HERMES_HOME: path.join(tmp, 'no-such-hermes') }),
  });
  assert.strictEqual(r.status, 0, '--help 退出码 ' + r.status + '：' + (r.stderr || r.error));
  assert.ok(/purge/.test(r.stdout || ''), '--help 没有输出用法');
  assert.ok(/--target=DIR/.test(r.stdout || ''), '--help 缺 --target 说明');
});

/* ───────────── 汇总 ───────────── */

console.log('\n' + (fail ? '失败 ' + fail + ' / 通过 ' + pass : '全部通过 ' + pass + '/' + (pass + fail)));
if (fail) process.exitCode = 1;
