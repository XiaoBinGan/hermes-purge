'use strict';
/**
 * test/install-sh.js —— install.sh 与 install.ps1 的能力对齐（mac 侧）
 *
 * Windows 那条线刚给 install.ps1 补了三件事，mac 侧要跟上，否则「一键装完即可用」只在 Windows 成立：
 *   ① 镜像：--base-url（ps1 是 -BaseUrl）
 *   ② PATH：默认写进 shell rc，且幂等；--no-path 可跳过（ps1 默认写用户 PATH，-NoPath 跳过）
 *   ③ 下载失败提示可换镜像 + 重试
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sh = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
const ps1 = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

console.log('\ninstall.sh ↔ install.ps1 能力对齐');

t('镜像：sh 有 --base-url / 环境变量，ps1 有 -BaseUrl', () => {
  assert.ok(/--base-url=/.test(sh), 'install.sh 没有 --base-url');
  assert.ok(/HERMES_PURGE_BASE_URL/.test(sh), 'install.sh 没有环境变量入口');
  assert.ok(/\$BaseUrl/.test(ps1), 'install.ps1 没有 -BaseUrl');
});

t('PATH：sh 默认写 shell rc，且有 --no-path；ps1 默认写用户 PATH，有 -NoPath', () => {
  assert.ok(/NO_PATH=0/.test(sh), 'sh 没有 NO_PATH 默认值');
  assert.ok(/--no-path\)/.test(sh), 'sh 没有 --no-path 参数');
  assert.ok(/rc_file\(\)/.test(sh), 'sh 没有 rc_file');
  assert.ok(/NoPath|NoPath\b|\$NoPath/.test(ps1) || /NoPath/.test(ps1), 'ps1 没有 -NoPath');
});

t('下载失败提示里带「换镜像」与重试', () => {
  assert.ok(/--retry 3/.test(sh), 'sh 下载没有重试');
  assert.ok(/换镜像/.test(sh), 'sh 下载失败提示没有换镜像建议');
  assert.ok(/换镜像/.test(ps1), 'ps1 下载失败提示没有换镜像建议');
});

// 真跑：空 HOME + 自定义 bin，验证 rc 只写一行且幂等、--no-path 不写
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-inst-'));
const home = path.join(tmp, 'home');
const bin = path.join(tmp, 'bin');
const app = path.join(tmp, 'app');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(app, { recursive: true });
// 伪装成「已经在仓库里」：把仓库结构软链到 app，避免真去下载
fs.symlinkSync(ROOT, path.join(app, 'repo'));
const rc = path.join(home, '.zshrc');
fs.writeFileSync(rc, '# rc\n');

const runInstall = (extraArgs) => spawnSync('bash', [path.join(ROOT, 'install.sh'), ...extraArgs], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, {
    HOME: home, SHELL: '/bin/zsh',
    HERMES_PURGE_HOME: app, HERMES_PURGE_BIN: bin,
  }),
});

if (process.platform !== 'win32') {
  t('真跑：写一行 PATH 进 .zshrc，重复装不重复写', () => {
    const r1 = runInstall([]);
    assert.strictEqual(r1.status, 0, r1.stderr);
    assert.strictEqual((fs.readFileSync(rc, 'utf8').match(/hermes-purge/g) || []).length, 1);
    const r2 = runInstall([]);
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.strictEqual((fs.readFileSync(rc, 'utf8').match(/hermes-purge/g) || []).length, 1, '重复写了');
  });

  t('真跑：--no-path 时不碰 rc', () => {
    fs.writeFileSync(rc, '# rc\n');
    const r = runInstall(['--no-path']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(rc, 'utf8'), '# rc\n', 'rc 被改了');
    assert.ok(/不在 PATH/.test(r.stderr + r.stdout), '没提示 PATH 未写');
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
