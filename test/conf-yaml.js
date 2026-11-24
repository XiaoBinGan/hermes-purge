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
  // shim 层要往 site-packages 写 .pth；没有它就报 no-site-packages，
  // 而 apply 现在把 shim 失败计入 failed 并置非零退出码（issue #15 要求），
  // 所以夹具要像个真宿主：给一个 site-packages。
  fs.mkdirSync(path.join(tree, 'venv', 'Lib', 'site-packages'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'venv', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(tree, 'venv', 'lib', 'python3.11', 'site-packages'), { recursive: true });
  return { home, tree };
}

const apply = (tree) => spawnSync(process.execPath, [CLI, 'apply', '--target=' + tree, '--no-verify'], { encoding: 'utf8' });
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

t('config 根上没有 model: 段时，补出 model.max_tokens（否则 C15 永远 pending）', () => {
  const { home, tree } = makeTree('approvals:\n  mode: prompt\n');
  const r = apply(tree);
  assert.strictEqual(r.status, 0, r.stderr);
  const cfg = readCfg(home);
  assert.ok(/^model:/m.test(cfg), '没有补出 model 段：\n' + cfg);
  assert.ok(/^\s*max_tokens:\s*16000/m.test(cfg), '没有写入 max_tokens：\n' + cfg);
  const st = JSON.parse(spawnSync(process.execPath, [CLI, 'status', '--json', '--target=' + tree], { encoding: 'utf8' }).stdout);
  const c15 = st.rows.find((x) => x.id === 'C15');
  assert.strictEqual(c15.status, 'applied', 'C15 = ' + c15.status + ' / ' + c15.detail);
  fs.rmSync(home, { recursive: true, force: true });
});

t('追加路径写出的 approvals 也带 marker，且每行只有一个', () => {
  const { home, tree } = makeTree('model:\n  default: x\n');
  apply(tree);
  apply(tree);
  const cfg = readCfg(home);
  const modeLine = cfg.split('\n').find((l) => /^\s*mode:/.test(l));
  assert.ok(modeLine && modeLine.includes('[hermes-purge]'), 'mode 行没有 marker：' + modeLine);
  for (const line of cfg.split('\n')) {
    assert.ok((line.match(/\[hermes-purge\]/g) || []).length <= 1, '同一行 marker 重复：' + line);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

t('.env 里值不对时会就地改写（不是只看键在不在）', () => {
  const { home, tree } = makeTree('model:\n  default: x\n');
  fs.writeFileSync(path.join(home, '.env'), 'HERMES_APPROVAL_MODE=prompt\nOTHER=2\n');
  apply(tree);
  const env = fs.readFileSync(path.join(home, '.env'), 'utf8');
  assert.ok(/^HERMES_APPROVAL_MODE=off$/m.test(env), '值没被改写：\n' + env);
  assert.ok(/^HERMES_YOLO_MODE=1$/m.test(env), '缺的键没追加：\n' + env);
  assert.ok(/^OTHER=2$/m.test(env), '无关行被动了：\n' + env);
  assert.strictEqual((env.match(/HERMES_APPROVAL_MODE=/g) || []).length, 1, '出现了重复键：\n' + env);
  fs.rmSync(home, { recursive: true, force: true });
});

t('.env 不存在时会创建，且开头不留空白行', () => {
  const { home, tree } = makeTree('model:\n  default: x\n');
  fs.rmSync(path.join(home, '.env'));
  apply(tree);
  const env = fs.readFileSync(path.join(home, '.env'), 'utf8');
  assert.ok(env.startsWith('# [hermes-purge]'), '开头有多余空白：' + JSON.stringify(env.slice(0, 20)));
  assert.ok(/^HERMES_YOLO_MODE=1$/m.test(env) && /^HERMES_APPROVAL_MODE=off$/m.test(env), env);
  const st = JSON.parse(spawnSync(process.execPath, [CLI, 'status', '--json', '--target=' + tree], { encoding: 'utf8' }).stdout);
  assert.strictEqual(st.rows.find((x) => x.id === 'G02').status, 'applied');
  fs.rmSync(home, { recursive: true, force: true });
});

t('.env 已经正确时不重复写（幂等）', () => {
  const { home, tree } = makeTree('model:\n  default: x\n');
  apply(tree);
  const first = fs.readFileSync(path.join(home, '.env'), 'utf8');
  apply(tree);
  assert.strictEqual(fs.readFileSync(path.join(home, '.env'), 'utf8'), first, '.env 不幂等');
  fs.rmSync(home, { recursive: true, force: true });
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
