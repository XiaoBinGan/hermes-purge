'use strict';
/**
 * test/panel-sync.js —— apply / revert 之后面板快照自动刷新
 *
 * 面板里嵌的是静态快照，状态变了不同步就会显示旧结论（用户看到「31/31」但其实刚 revert 过）。
 * 这里端到端验：装好面板 → 跑 apply → 快照必须变；再 revert → 又快照必须变；
 * `--no-panel-sync` 必须能关掉。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'purge.js');
const desktop = require('../lib/v2/desktop');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

function makeHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-panel-'));
  const tree = path.join(home, 'hermes-agent');
  for (const d of ['agent/transports', 'hermes_cli', 'tools']) {
    fs.mkdirSync(path.join(tree, d), { recursive: true });
  }
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
const snapshot = (dist) => fs.readFileSync(path.join(dist, 'purge-panel.js'), 'utf8');
const stamp = (dist) => (snapshot(dist).match(/"generatedAt":"([^"]*)"/) || [])[1];

console.log('\n面板快照自动刷新');

t('没装面板时：apply 不报错，也不创建快照', () => {
  const { home, tree, dist } = makeHost();
  const r = run(['apply'], tree);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dist, 'purge-panel.js')), '没装面板却写了快照');
  fs.rmSync(home, { recursive: true, force: true });
});

t('装了面板时：apply 之后快照自动刷新', () => {
  const { home, tree, dist } = makeHost();
  desktop.install(dist, { report: '<html>OLD</html>', version: 'x', generatedAt: '2000-01-01 00:00:00' });
  const before = stamp(dist);
  const r = run(['apply'], tree);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('面板快照已刷新'), '没有提示刷新：' + r.stdout.slice(-200));
  const after = stamp(dist);
  assert.notStrictEqual(after, before, '快照时间戳没变');
  assert.ok(!snapshot(dist).includes('OLD'), '快照里还是旧报告');
  fs.rmSync(home, { recursive: true, force: true });
});

t('revert 之后也会刷新（内容必须变，时间戳同秒不算）', () => {
  const { home, tree, dist } = makeHost();
  desktop.install(dist, { report: 'X', version: 'x' });
  run(['apply'], tree);
  const afterApply = snapshot(dist);
  const r = run(['revert'], tree);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('面板快照已刷新'), r.stdout.slice(-200));
  assert.notStrictEqual(snapshot(dist), afterApply, 'revert 后快照内容没变（还是 apply 后的状态）');
  fs.rmSync(home, { recursive: true, force: true });
});

t('--no-panel-sync 能关掉自动刷新', () => {
  const { home, tree, dist } = makeHost();
  desktop.install(dist, { report: 'KEEP-ME', version: 'x' });
  const before = snapshot(dist);
  const r = run(['apply', '--no-panel-sync'], tree);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('面板快照已刷新'), '不该刷新');
  assert.strictEqual(snapshot(dist), before, '快照被改了');
  fs.rmSync(home, { recursive: true, force: true });
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
