'use strict';
/**
 * test/conf-yaml.js —— 配置层写入的两个老坑（2026-11 在 Hermes 0.21.4 上暴露）
 *
 *  ① 已有 approvals 段时只改 timeout、不改 mode → G01 永远 pending
 *  ② 重复 apply 会在同一行再追加 `# [hermes-purge]` → 注释层层叠加
 *
 * 这里用真实 CLI 端到端跑：造最小宿主树 → purge apply → 读回 config.yaml。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'purge.js');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

function makeTree(configYaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-conf-'));
  const tree = path.join(home, 'hermes-agent');
  fs.mkdirSync(path.join(tree, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'hermes_cli'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'agent', 'transports'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), configYaml);
  fs.writeFileSync(path.join(home, '.env'), '');
  fs.writeFileSync(path.join(home, 'SOUL.md'), '# soul\n');
  fs.writeFileSync(path.join(tree, 'SOUL.md'), '# soul\n');
  return { home, tree };
}

const apply = (tree) => spawnSync(process.execPath, [CLI, 'apply', '--target=' + tree], { encoding: 'utf8' });
const readCfg = (home) => fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');

console.log('\n配置层（config.yaml）');

t('已有 approvals 段：mode 改成 off、timeout 提到 86400', () => {
  const { home, tree } = makeTree('model:\n  default: x\napprovals:\n  mode: prompt\n  timeout: 60\n');
  const r = apply(tree);
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = readCfg(home);
  assert.ok(/^\s*mode:\s*'off'/m.test(cfg), 'mode 没改成 off：\n' + cfg);
  assert.ok(/^\s*timeout:\s*86400/m.test(cfg), 'timeout 没提到 86400：\n' + cfg);
  fs.rmSync(home, { recursive: true, force: true });
});

t('重复 apply：同一行不会叠加多个 marker（幂等）', () => {
  const { home, tree } = makeTree('model:\n  default: x\napprovals:\n  mode: smart\n  timeout: 30\n');
  apply(tree);
  const first = readCfg(home);
  apply(tree);
  const second = readCfg(home);
  assert.strictEqual(second, first, '两次 apply 结果不一致（不幂等）');
  for (const line of second.split('\n')) {
    const marks = (line.match(/\[hermes-purge\]/g) || []).length;
    assert.ok(marks <= 1, '同一行有 ' + marks + ' 个 marker：' + line);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

t('没有 approvals 段：整段追加，含 mode off 与 timeout 86400', () => {
  const { home, tree } = makeTree('model:\n  default: x\n');
  apply(tree);
  const cfg = readCfg(home);
  assert.ok(/^approvals:/m.test(cfg), '没有追加 approvals 段：\n' + cfg);
  assert.ok(/^\s*mode:\s*'off'/m.test(cfg));
  assert.ok(/^\s*timeout:\s*86400/m.test(cfg));
  fs.rmSync(home, { recursive: true, force: true });
});

t('apply 之后 G01 状态是 applied，不是 pending', () => {
  const { home, tree } = makeTree('model:\n  default: x\napprovals:\n  mode: prompt\n  timeout: 60\n');
  apply(tree);
  const r = spawnSync(process.execPath, [CLI, 'status', '--json', '--target=' + tree], { encoding: 'utf8' });
  const rows = JSON.parse(r.stdout).rows;
  const g01 = rows.find((x) => x.id === 'G01');
  assert.strictEqual(g01.status, 'applied', 'G01 = ' + g01.status + ' / ' + g01.detail);
  fs.rmSync(home, { recursive: true, force: true });
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
