'use strict';
/**
 * test/version-gap.js —— 「该版本没有此机制」不等于「漂移」
 *
 * 3.3.0 起补丁面 41 条，其中 C26/C27 依赖 0.21.4+ 才有的模块。
 * 老宿主上它们应该报 `unsupported`（带说明），而不是 drifted —— 否则
 * 「drifted 0」这个判据就失效了，用户还会以为补丁坏了。
 *
 * 同时锁住：dsh adapter 不受影响（那边文件不存在就该是 drifted）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'purge.js');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

function stubHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-gap-'));
  const tree = path.join(home, 'hermes-agent');
  for (const d of ['agent/transports', 'hermes_cli', 'tools']) fs.mkdirSync(path.join(tree, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: x\n');
  fs.writeFileSync(path.join(home, '.env'), '');
  fs.writeFileSync(path.join(home, 'SOUL.md'), '# soul\n');
  fs.writeFileSync(path.join(tree, 'SOUL.md'), '# soul\n');
  return { home, tree };
}

console.log('\n版本缺口标记（unsupported）');

t('空宿主上：缺文件的 cap 报 unsupported，不是 drifted', () => {
  const { home, tree } = stubHost();
  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--target=' + tree], { encoding: 'utf8' });
  const rows = JSON.parse(r.stdout).rows;
  const gap = rows.filter((x) => x.status === 'unsupported');
  assert.ok(gap.length > 0, '没有任何 unsupported（说明判据没生效）');
  for (const g of gap) {
    assert.ok(/版本较老/.test(g.detail), '说明文字缺失：' + g.detail);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

t('unsupported 不计入 drifted（命令行的 drifted 数为 0）', () => {
  const { home, tree } = stubHost();
  const r = spawnSync(process.execPath, [CLI, 'status', '--target=' + tree], { encoding: 'utf8' });
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(/drifted 0/.test(out), 'drifted 不是 0：' + out.split('\n').slice(0, 3).join(' | '));
  fs.rmSync(home, { recursive: true, force: true });
});

t('dsh adapter 不受影响：文件不存在仍算 drifted', () => {
  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--adapter=dsh', '--target=' + path.join(__dirname, '..')], { encoding: 'utf8' });
  if (r.status !== 0 && !r.stdout) return;   // 没 dsh 夹具就跳过
  const rows = JSON.parse(r.stdout).rows;
  assert.strictEqual(rows.filter((x) => x.status === 'unsupported').length, 0, 'dsh 不该出现 unsupported');
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
