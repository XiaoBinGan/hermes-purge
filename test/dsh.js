'use strict';
/**
 * test/dsh.js —— DSH adapter 的结构验证（不需要真机 DSH）
 *
 *   node test/dsh.js
 *
 * 做什么：
 *   1. 在临时目录造一棵 dsh 0.2 风格的夹具树（test/dsh-fixture.js，不进仓库）
 *   2. records 初始哈希
 *   3. 跑 status（--adapter=dsh 与 auto 两路）→ 断言 40 条 cap 的探测状态合理
 *   4. 跑 apply → 断言 conf / text / shim 三类真的落盘
 *   5. 跑 verify --level=1|2 → 断言断言层全绿
 *   6. 跑 revert → 断言夹具树逐字节回到初始（哈希比对）
 *
 * 不做什么：不验证真 DSH 会不会照这些配置跑 —— 本机没有 DSH 安装，
 * 这一层只有规格与结构验证，报告里必须如实写。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const fixture = require('./dsh-fixture');
const adapters = require('../lib/v2/adapters');
const capsLib = require('../lib/v2/caps');

const ROOT = process.env.DSH_FIXTURE || fixture.ROOT_PRESET;
const PURGE = path.join(__dirname, '..', 'bin', 'purge.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

function run(argv) {
  const r = spawnSync(process.execPath, [PURGE].concat(argv), { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  return { status: r.status, out: strip(r.stdout) + strip(r.stderr), raw: (r.stdout || '') + (r.stderr || '') };
}

function hashAll() {
  const map = {};
  for (const rel of fixture.listFiles(ROOT)) {
    map[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
  }
  return map;
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

/* ───────────── 0. 夹具 ───────────── */

fixture.build(ROOT);
const before = hashAll();
console.log('\n夹具树 ' + ROOT + '（' + Object.keys(before).length + ' 个文件）');

/* ───────────── 1. adapter 探测 ───────────── */

console.log('\nadapter 注册表与探测');

t('detect(dsh 夹具) = dsh', () => {
  assert.strictEqual(adapters.detect(ROOT), 'dsh');
});

t('detect(hermes 布局) = hermes', () => {
  const fake = path.join(ROOT, '..', 'purge-hermes-probe');
  fs.rmSync(fake, { recursive: true, force: true });
  fs.mkdirSync(path.join(fake, 'hermes_cli'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'agent'), { recursive: true });
  try {
    assert.strictEqual(adapters.detect(fake), 'hermes');
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

t('detect(陌生目录) = null，resolve 报错并提示 --adapter', () => {
  const fake = path.join(ROOT, '..', 'purge-unknown-probe');
  fs.rmSync(fake, { recursive: true, force: true });
  fs.mkdirSync(fake, { recursive: true });
  try {
    assert.strictEqual(adapters.detect(fake), null);
    let msg = '';
    try { adapters.resolve({ target: fake, undetected: 'throw' }); } catch (e) { msg = e.message; }
    assert.ok(msg.includes('--adapter'), '报错没带 --adapter 提示: ' + msg);
    // 库调用不炸：探测不到默认 hermes（1.x 向后兼容）
    assert.strictEqual(adapters.resolve({ target: fake }).id, 'hermes');
    assert.strictEqual(capsLib.buildCaps({ target: fake }).length, 77);
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

t('buildCaps() 不传参仍是 hermes 77 条（1.x 向后兼容）', () => {
  assert.strictEqual(capsLib.buildCaps().length, 77);
});

t('buildCaps({adapter:dsh}) = 40 条，id 唯一', () => {
  const caps = capsLib.buildCaps({ adapter: 'dsh', target: ROOT });
  assert.strictEqual(caps.length, 40);
  assert.strictEqual(new Set(caps.map((c) => c.id)).size, 40);
});

t('每条 dsh cap 至少一个实现 + 一条断言', () => {
  for (const c of capsLib.buildCaps({ adapter: 'dsh', target: ROOT })) {
    assert.ok(c.impls.length >= 1, c.id + ' 没实现');
    assert.ok((c.asserts || []).length >= 1, c.id + ' 没断言');
  }
});

/* ───────────── 2. status ───────────── */

console.log('\nstatus（夹具初始状态）');

let status = null;
t('status --adapter=dsh 人读输出退出码 1（有未生效项）', () => {
  const r = run(['status', '--target=' + ROOT, '--adapter=dsh']);
  assert.strictEqual(r.status, 1, '有 pending 时 status 应 exit 1');
  assert.ok(r.out.includes('有未生效项'), r.out.slice(-200));
});

t('status --json 可解析，40 条 + adapter=dsh', () => {
  const r = run(['status', '--target=' + ROOT, '--adapter=dsh', '--json']);
  status = JSON.parse(r.out);
  assert.strictEqual(status.adapter, 'dsh');
  assert.strictEqual(status.rows.length, 40);
});

t('探测状态三态齐全：applied / pending / drifted 都出现', () => {
  const by = (s) => status.rows.filter((r) => r.status === s).length;
  const [a, p, d] = [by('applied'), by('pending'), by('drifted')];
  console.log('      applied ' + a + ' · pending ' + p + ' · drifted ' + d);
  assert.ok(a > 0 && p > 0 && d > 0, '三态不齐: applied ' + a + ' pending ' + p + ' drifted ' + d);
});

t('夹具里预置的三条是真 applied（D01 / D25 / D30）', () => {
  for (const id of ['D01', 'D25', 'D30']) {
    const row = status.rows.find((r) => r.id === id);
    assert.strictEqual(row.status, 'applied', id + ' = ' + row.status);
  }
});

t('夹具缺 headless profile → D26 / D35 如实报 drifted（不瞎写）', () => {
  for (const id of ['D26', 'D35']) {
    const row = status.rows.find((r) => r.id === id);
    assert.strictEqual(row.status, 'drifted', id + ' = ' + row.status);
  }
});

t('auto 探测（不传 --adapter）结果与 dsh 一致', () => {
  const r = run(['status', '--target=' + ROOT, '--json']);
  const auto = JSON.parse(r.out);
  assert.strictEqual(auto.adapter, 'dsh');
  assert.strictEqual(auto.rows.filter((x) => x.status === 'pending').length,
    status.rows.filter((x) => x.status === 'pending').length);
});

t('status 人类可读输出带 adapter 标记与分组', () => {
  const r = run(['status', '--target=' + ROOT, '--adapter=dsh']);
  assert.ok(r.out.includes('adapter= dsh') || r.out.includes('· dsh'), r.out.split('\n')[0]);
  for (const g of ['approval', 'guardrail', 'prompt', 'config', 'shim']) {
    assert.ok(r.out.includes('── ' + g + ' ──'), '缺分组 ' + g);
  }
});

/* ───────────── 3. apply ───────────── */

console.log('\napply（conf / text / shim 三类落盘）');

let applyOut = '';
t('apply 退出码 0', () => {
  const r = run(['apply', '--target=' + ROOT, '--adapter=dsh']);
  applyOut = r.out;
  assert.strictEqual(r.status, 0, r.out.slice(-800));
});

t('conf：desktop profile 写入 permission-presets / agent-loop', () => {
  const f = read('profiles/desktop/cordis.patch.yml');
  assert.ok(f.includes('id: permission-presets'), f);
  assert.ok(f.includes("approvalMode: 'off'"), f);
  assert.ok(f.includes('id: agent-loop'), f);
});

t('conf：settings.yaml 的 model / temperature / max_tokens 被覆盖', () => {
  const f = read('config/settings.yaml');
  assert.ok(/^model:\s*deepseek-v4-pro/m.test(f), f);
  assert.ok(/^temperature:\s*1\.35/m.test(f), f);
  assert.ok(/^max_tokens:\s*32768/m.test(f), f);
});

t('conf：根 cordis.patch.yml 的 postPrompt 注入 + persona 覆盖', () => {
  const f = read('cordis.patch.yml');
  assert.ok(/postPrompt: "/.test(f), f);
  assert.ok(f.includes("override: '小码酱'"), f);
});

t('conf：profile package.json 的 patchReload=live 且 bundles 登记 dsh-purge', () => {
  for (const p of ['profiles/web/package.json', 'profiles/desktop/package.json']) {
    const j = JSON.parse(read(p));
    assert.strictEqual(j.dsh.profile.patchReload, 'live', p);
    assert.ok(j.dsh.profile.bundles.includes('dsh-purge'), p + ' bundles 少了 dsh-purge');
  }
});

t('text：hooks.js 的审批 / 护栏开关被改（含 sentinel）', () => {
  const f = read('plugins/dsh-purge/lib/hooks.js');
  assert.ok(f.includes("APPROVAL_HOOK = 'allow'"), f);
  assert.ok(f.includes("LOOP_GUARD = 'allow'"), f);
  assert.ok(f.includes("TOOL_WHITELIST = 'all'"), f);
  assert.ok(f.includes('[hermes-purge] D03'), '缺 sentinel');
});

t('text：regex.js 硬红线表清空、prompt.js 注入段、instructions 追加', () => {
  assert.ok(read('plugins/dsh-purge/lib/regex.js').includes('HARDLINE_PATTERNS = []'));
  assert.ok(read('plugins/dsh-purge/lib/prompt.js').includes('DSH_PURGE_PROMPT'));
  assert.ok(read('plugins/dsh-purge/lib/instructions.js').includes('EXTRA.push('));
});

t('shim：preload.js 注入且含各 cap 条目', () => {
  assert.ok(exists('plugins/dsh-purge/shim/preload.js'), 'preload.js 没落盘');
  const f = read('plugins/dsh-purge/shim/preload.js');
  for (const id of ['D02', 'D36', 'D38', 'D39', 'D40']) {
    assert.ok(f.includes('"cap": "' + id + '"'), '缺 ' + id);
  }
});

t('shim：launch-env.json 的 NODE_OPTIONS 接上 --require', () => {
  const j = JSON.parse(read('config/launch-env.json'));
  assert.ok(String(j.NODE_OPTIONS).includes('--require'), JSON.stringify(j));
  assert.ok(String(j.NODE_OPTIONS).includes('preload.js'), JSON.stringify(j));
});

t('override 清单文件落盘（shim 组 D37）', () => {
  assert.ok(read('plugins/dsh-purge/shim/override.json').includes('[hermes-purge] D37'));
});

t('apply 输出里 shim 收尾有统计', () => {
  assert.ok(/shim \d+ 条 · \d+ 个文件/.test(applyOut), applyOut.slice(-400));
});

/* ───────────── 4. apply 后 status ───────────── */

console.log('\napply 后 status');

t('pending 归零，只剩 2 条 drifted（headless）', () => {
  const r = run(['status', '--target=' + ROOT, '--adapter=dsh', '--json']);
  const s = JSON.parse(r.out);
  const by = (x) => s.rows.filter((y) => y.status === x).length;
  assert.strictEqual(by('pending'), 0, '还有 pending: ' + s.rows.filter((y) => y.status === 'pending').map((y) => y.id).join(','));
  assert.strictEqual(by('drifted'), 2, 'drifted = ' + by('drifted'));
  assert.strictEqual(by('applied'), 38, 'applied = ' + by('applied'));
});

/* ───────────── 5. verify ───────────── */

console.log('\nverify');

t('verify --level=1 通过（node --check / json / yaml 结构）', () => {
  const r = run(['verify', '--level=1', '--target=' + ROOT, '--adapter=dsh']);
  assert.strictEqual(r.status, 0, r.out);
});

t('verify --level=2 通过（每条 cap 的断言，drifted 跳过并标注）', () => {
  const r = run(['verify', '--level=2', '--target=' + ROOT, '--adapter=dsh']);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(r.out.includes('L2 运行时'), r.out);
  assert.ok(r.out.includes('跳过（drifted）'), '跳过项没标注: ' + r.out);
});

t('verify --level=3 如实报「未在真机跑过」', () => {
  const r = run(['verify', '--level=3', '--target=' + ROOT, '--adapter=dsh']);
  assert.strictEqual(r.status, 1, 'L3 不该假装通过');
  assert.ok(r.out.includes('未在真机'), r.out);
});

/* ───────────── 6. doctor / revert ───────────── */

console.log('\ndoctor 与 revert');

t('doctor 不再套用 hermes 的 python / site-packages 检查', () => {
  const r = run(['doctor', '--target=' + ROOT, '--adapter=dsh']);
  assert.ok(!r.out.includes('宿主 python'), r.out);
  assert.ok(r.out.includes('NODE_OPTIONS'), r.out);
});

t('revert 退出码 0', () => {
  const r = run(['revert', '--target=' + ROOT, '--adapter=dsh']);
  assert.strictEqual(r.status, 0, r.out);
});

t('revert 后夹具树逐字节回到初始（哈希比对）', () => {
  const after = hashAll();
  const bad = [];
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) { bad.push(rel + ' 丢了'); continue; }
    if (after[rel] !== before[rel]) bad.push(rel + ' 内容变了');
  }
  for (const rel of Object.keys(after)) {
    if (!(rel in before)) bad.push(rel + ' 多出来了');
  }
  assert.strictEqual(bad.length, 0, bad.join('; '));
});

t('revert 后 shim 预加载已删除', () => {
  assert.ok(!exists('plugins/dsh-purge/shim/preload.js'), 'preload.js 还在');
});

t('revert 后 status 回到初始（pending 与 drifted 数目与基线一致）', () => {
  const r = run(['status', '--target=' + ROOT, '--adapter=dsh', '--json']);
  const s = JSON.parse(r.out);
  const key = (rows) => rows.map((x) => x.id + ':' + x.status).join(',');
  assert.strictEqual(key(s.rows), key(status.rows));
});

console.log('\n' + (fail === 0 ? '全部通过 ' + pass + '/' + pass : pass + ' 通过 · ' + fail + ' 失败'));
process.exit(fail === 0 ? 0 : 1);