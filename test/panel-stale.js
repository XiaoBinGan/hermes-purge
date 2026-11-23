'use strict';
/**
 * test/panel-stale.js —— 面板快照过期检测
 *
 * 面板里嵌的是静态快照。版本升级后（改代码/改文档不走 apply）快照会一直是旧的，
 * 用户看到的是过期结论。这里验：doctor 与 `desktop status` 能报出过期，sync 之后恢复一致。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'purge.js');
const desktop = require('../lib/v2/desktop');
const pkgVersion = require('../package.json').version;
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

function makeHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-stale-'));
  const tree = path.join(home, 'hermes-agent');
  for (const d of ['agent/transports', 'hermes_cli', 'tools']) fs.mkdirSync(path.join(tree, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: x\n');
  fs.writeFileSync(path.join(home, '.env'), '');
  fs.writeFileSync(path.join(home, 'SOUL.md'), '# soul\n');
  fs.writeFileSync(path.join(tree, 'SOUL.md'), '# soul\n');
  const dist = path.join(tree, 'apps', 'desktop', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body></body></html>');
  return { home, tree, dist };
}

const run = (args, tree) => spawnSync(process.execPath, [CLI, ...args, '--target=' + tree], { encoding: 'utf8' });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

console.log('\n面板快照过期检测');

t('snapshotInfo 能读出面板里的版本与生成时间', () => {
  const { home, tree, dist } = makeHost();
  desktop.install(dist, { report: 'X', version: '0.0.1-old', generatedAt: '2020-01-01 00:00:00' });
  const info = desktop.snapshotInfo(dist);
  assert.strictEqual(info.snapshotVersion, '0.0.1-old');
  assert.strictEqual(info.snapshotAt, '2020-01-01 00:00:00');
  fs.rmSync(home, { recursive: true, force: true });
});

t('版本落后 → isStale 为真，doctor 报「过期」并给修复命令', () => {
  const { home, tree, dist } = makeHost();
  desktop.install(dist, { report: 'X', version: '0.0.1-old', generatedAt: '2020-01-01 00:00:00' });
  assert.strictEqual(desktop.isStale(dist, pkgVersion), true);
  const r = run(['doctor'], tree);
  const out = strip(r.stdout + r.stderr);
  assert.ok(/面板快照/.test(out), 'doctor 没提面板快照：' + out.slice(-300));
  assert.ok(/过期/.test(out), '没报过期：' + out.slice(-300));
  assert.ok(/purge desktop sync/.test(out), '没给修复命令：' + out.slice(-300));
  fs.rmSync(home, { recursive: true, force: true });
});

t('sync 之后不再过期，doctor 显示一致', () => {
  const { home, tree, dist } = makeHost();
  desktop.install(dist, { report: 'X', version: '0.0.1-old', generatedAt: '2020-01-01 00:00:00' });
  run(['desktop', 'sync'], tree);
  assert.strictEqual(desktop.isStale(dist, pkgVersion), false);
  const r = run(['doctor'], tree);
  const out = strip(r.stdout + r.stderr);
  assert.ok(/与当前版本一致/.test(out), out.slice(-300));
  fs.rmSync(home, { recursive: true, force: true });
});

t('desktop status 直接报版本与是否过期', () => {
  const { home, tree, dist } = makeHost();
  desktop.install(dist, { report: 'X', version: '0.0.1-old', generatedAt: '2020-01-01 00:00:00' });
  const r = run(['desktop', 'status'], tree);
  const out = strip(r.stdout);
  assert.ok(/快照\s+0\.0\.1-old/.test(out), '没打印快照版本：' + out);
  assert.ok(/已过期/.test(out), '没标过期：' + out);
  fs.rmSync(home, { recursive: true, force: true });
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
