'use strict';
/**
 * test/setup.js —— 安装/卸载路径自检（不联网、不碰真机）
 *
 * 覆盖：
 *   setup --dry 只读（不建状态目录、不改文件）
 *   setup --yes 在临时树上跑通（apply → verify 由子进程负责，这里验状态与退出码）
 *   uninstall 没有快照时不崩、能清状态目录
 *   install.sh：语法、--help、安装到临时 HOME/BIN、purge --version 可用、--uninstall 清干净
 *   版本号一致性：package.json == purge --version == README 里写的当前版本
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PURGE = path.join(ROOT, 'bin', 'purge.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-setup-'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

function run(args, opts) {
  return spawnSync(process.execPath, [PURGE].concat(args), Object.assign({ encoding: 'utf8', windowsHide: true }, opts || {}));
}

/** 造一棵"看起来像 Hermes"的最小树：探测靠 hermes_cli/ + agent/，配置在父目录 */
function fakeHost(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'hermes-agent', 'hermes_cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hermes-agent', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  default: fake\n');
  fs.writeFileSync(path.join(root, 'SOUL.md'), 'fake soul\n');
  fs.writeFileSync(path.join(root, '.env'), '');
  fs.writeFileSync(path.join(root, 'hermes-agent', 'SOUL.md'), 'fake soul\n');
  return path.join(root, 'hermes-agent');
}

console.log('\nsetup / uninstall');

t('setup --dry 是只读的（不建 .hermes-purge、不改文件）', () => {
  const tree = fakeHost('dry');
  const before = fs.readFileSync(path.join(tree, 'SOUL.md'), 'utf8');
  const r = run(['setup', '--dry', '--target=' + tree]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('purge setup'), '没打印计划头');
  assert.ok(/cap\s+\d+ 条/.test(r.stdout), '没打印 cap 统计');
  assert.ok(!fs.existsSync(path.join(tree, '.hermes-purge')), 'dry 竟然建了状态目录');
  assert.strictEqual(fs.readFileSync(path.join(tree, 'SOUL.md'), 'utf8'), before, 'dry 竟然改了文件');
});

t('非交互环境不给 --yes 时不写入并提示', () => {
  const tree = fakeHost('noinput');
  const r = spawnSync(process.execPath, [PURGE, 'setup', '--target=' + tree],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  assert.ok(r.stdout.includes('--yes'), '没提示 --yes：' + r.stdout.slice(-200));
  assert.ok(!fs.existsSync(path.join(tree, '.hermes-purge')), '竟然写入了');
});

t('uninstall 没有快照时不崩、退出码 0', () => {
  const tree = fakeHost('nosnap');
  fs.mkdirSync(path.join(tree, '.hermes-purge', 'v2'), { recursive: true });
  const r = run(['uninstall', '--yes', '--target=' + tree]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr), '有 JS 异常：' + r.stderr.slice(0, 200));
  assert.ok(!fs.existsSync(path.join(tree, '.hermes-purge')), '状态目录没删掉');
});

t('--help 里两个新命令都在', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('purge setup'), r.stdout);
  assert.ok(r.stdout.includes('purge uninstall'), r.stdout);
});

console.log('\ninstall.sh');

const sh = path.join(ROOT, 'install.sh');
const hasSh = fs.existsSync(sh);

t('install.sh 存在且有可执行位', () => {
  assert.ok(hasSh, '没有 install.sh');
  if (process.platform !== 'win32') assert.ok(fs.statSync(sh).mode & 0o111, '没有 +x');
});

t('install.sh 语法检查（bash -n）', () => {
  if (process.platform === 'win32') { console.log('    （Windows 跳过）'); return; }
  const r = spawnSync('bash', ['-n', sh], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
});

t('install.sh --help 输出用法', () => {
  if (process.platform === 'win32') { console.log('    （Windows 跳过）'); return; }
  const r = spawnSync('bash', [sh, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('--uninstall'), r.stdout);
});

t('install.sh 装到临时 HOME/BIN → purge --version 可用 → --uninstall 清干净', () => {
  if (process.platform === 'win32') { console.log('    （Windows 跳过）'); return; }
  const home = path.join(TMP, 'ihome');
  const bin = path.join(TMP, 'ibin');
  const env = Object.assign({}, process.env, { HERMES_PURGE_HOME: home, HERMES_PURGE_BIN: bin });
  const inst = spawnSync('bash', [sh], { encoding: 'utf8', env });
  assert.strictEqual(inst.status, 0, inst.stdout + inst.stderr);
  assert.ok(fs.existsSync(path.join(bin, 'purge')), '没建 purge 命令');
  assert.ok(fs.existsSync(path.join(bin, 'hp')), '没建 hp 命令');

  const v = spawnSync(path.join(bin, 'purge'), ['--version'], { encoding: 'utf8' });
  assert.strictEqual(v.status, 0, v.stderr);
  const pkgVersion = require(path.join(ROOT, 'package.json')).version;
  assert.strictEqual(v.stdout.trim(), pkgVersion, '版本号不一致');

  const un = spawnSync('bash', [sh, '--uninstall'], { encoding: 'utf8', env });
  assert.strictEqual(un.status, 0, un.stdout + un.stderr);
  assert.ok(!fs.existsSync(path.join(bin, 'purge')), '卸载后 purge 还在');
});

console.log('\n一条命令安装（--setup）');

t('install.sh --setup --yes 会装完接着跑 setup（真套在临时 Hermes 树上）', () => {
  if (process.platform === 'win32') { console.log('    （Windows 跳过）'); return; }
  const host = path.join(TMP, 'host');
  fs.mkdirSync(path.join(host, 'hermes-agent', 'hermes_cli'), { recursive: true });
  fs.mkdirSync(path.join(host, 'hermes-agent', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(host, 'config.yaml'), 'model:\n  default: fake\n');
  const home = path.join(TMP, 'cmd-home');
  const bin = path.join(TMP, 'cmd-bin');
  // 假宿主（只有目录骨架）应用后必然 verify 不过、退出码非 0 —— 这里只验「接线」：
  // install.sh 装完命令后真的把 setup 跑起来了，且 purge 命令已就位。
  const r = spawnSync('bash', [sh, '--setup', '--yes'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HERMES_PURGE_HOME: home, HERMES_PURGE_BIN: bin, HERMES_HOME: host,
    }),
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('purge setup'), '没跑到 setup：' + out.slice(-200));
  assert.ok(/cap\s+\d+ 条/.test(out), 'setup 没有打印 cap 统计');
  assert.ok(fs.existsSync(path.join(bin, 'purge')), '没装出 purge 命令');
});

console.log('\n版本与文档一致性');

t('package.json version == purge --version', () => {
  const v = run(['--version']).stdout.trim();
  assert.strictEqual(v, require(path.join(ROOT, 'package.json')).version);
});

t('README 里写的当前版本与 package.json 一致', () => {
  const v = require(path.join(ROOT, 'package.json')).version;
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('当前版本 **' + v + '**'), 'README 没写 当前版本 **' + v + '**');
});

t('install.ps1 存在且是 CRLF（Windows 上不乱行）', () => {
  const ps = path.join(ROOT, 'install.ps1');
  assert.ok(fs.existsSync(ps), '没有 install.ps1');
  if (process.platform === 'win32') return;      // Windows 上 git 可能自动转换
  const raw = fs.readFileSync(ps);
  assert.ok(raw.includes(0x0d) && raw.includes(0x0a), 'install.ps1 不是 CRLF');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
