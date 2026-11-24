'use strict';
/**
 * test/plugin.js —— Hermes 插件（无损扩展）自检
 *
 * 这个插件不是补丁：只往 Hermes 的插件系统里注册「/purge 命令」和「purge_status 工具」，
 * 删掉目录就干净了。所以测试要盯三件事：
 *   1. install / uninstall 只动 ${HERMES_HOME}/plugins/hermes_purge，且可逆
 *   2. 模块能被 Hermes 的方式导入（importlib + 包路径），register(ctx) 真的注册了东西
 *   3. 命令处理器在「有 CLI / 没 CLI」两种情况下都给人话，不抛栈
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PURGE = path.join(ROOT, 'bin', 'purge.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-plugin-'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

const py = (() => {
  const p = require('../lib/v2/platform');
  // pickPython 会真的探一次：Windows 上 which('python3') 常是 .bat 代理，spawn 直接 EINVAL
  return p.pickPython(ROOT);
})();

/** 造一棵最小 Hermes 树：只要 hermes_cli/agent + config.yaml 就够探测 */
function fakeHost(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'hermes-agent', 'hermes_cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hermes-agent', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.yaml'), 'model:\n  default: fake\n');
  return { home: root, tree: path.join(root, 'hermes-agent') };
}

const host = fakeHost('host');
const pluginDir = path.join(host.home, 'plugins', 'hermes_purge');

console.log('\n安装 / 卸载');

t('install 把模板与 path.json 写进 $HERMES_HOME/plugins/hermes_purge', () => {
  const r = spawnSync(process.execPath, [PURGE, 'plugin', 'install', '--target=' + host.tree],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HERMES_HOME: host.home }), windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  for (const f of ['plugin.yaml', '__init__.py', 'path.json']) {
    assert.ok(fs.existsSync(path.join(pluginDir, f)), '缺 ' + f);
  }
  const spec = JSON.parse(fs.readFileSync(path.join(pluginDir, 'path.json'), 'utf8'));
  assert.ok(spec.cli && fs.existsSync(spec.cli), 'path.json 的 cli 不可用：' + spec.cli);
  assert.ok(spec.node, 'path.json 缺 node');
});

t('install 幂等（再跑一次不报错、文件还在）', () => {
  const r = spawnSync(process.execPath, [PURGE, 'plugin', 'install', '--target=' + host.tree],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HERMES_HOME: host.home }), windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.yaml')));
});

t('status 能看出已安装', () => {
  const r = spawnSync(process.execPath, [PURGE, 'plugin', 'status', '--target=' + host.tree],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HERMES_HOME: host.home }), windowsHide: true });
  assert.ok(r.stdout.includes('已安装'), r.stdout);
});

console.log('\n模块契约（按 Hermes 的方式导入）');

const stubCli = path.join(TMP, 'stub-purge.js');
fs.writeFileSync(stubCli, `#!/usr/bin/env node
const rows = [
  { id: 'C01', cap: 'a', layer: 'code', impl: 'ast', status: 'applied' },
  { id: 'C13', cap: 'b', layer: 'code', impl: 'text', status: 'applied' },
  { id: 'C20', cap: 'c', layer: 'code', impl: 'text', status: 'drifted' },
];
console.log(JSON.stringify({ target: '/fake/tree', rows }));
`);

function runPy(code, env) {
  const p = require('../lib/v2/platform');
  return p.spawnAny(py, ['-c', code], {
    encoding: 'utf8',
    env: p.pyEnv(env || {}),
  });
}

if (!py) {
  console.log('  - 跳过 python 契约（本机无 python）');
} else {
  const harness = `
import importlib.util, json, sys
p = ${JSON.stringify(path.join(pluginDir, '__init__.py'))}
spec = importlib.util.spec_from_file_location('hermes_purge_plugin', p, submodule_search_locations=[${JSON.stringify(pluginDir)}])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class Ctx:
    def __init__(self):
        self.commands, self.tools = [], []
    def register_command(self, name, handler, description="", args_hint="", **kw):
        self.commands.append({"name": name, "desc": description, "args": args_hint, "handler": handler})
    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools.append({"name": name, "toolset": toolset, "schema": schema})

c = Ctx(); m.register(c)
out = {"commands": [(x["name"], x["args"]) for x in c.commands],
       "tools": [(x["name"], x["toolset"]) for x in c.tools]}
if c.commands:
    out["status_text"] = c.commands[0]["handler"]("")
    out["bad"] = c.commands[0]["handler"]("不存在的子命令")
if c.tools:
    r = c.tools[0]["schema"]
    out["schema_ok"] = isinstance(r, dict) and r.get("name") == "purge_status"
print(json.dumps(out, ensure_ascii=False))
`;
  const r = runPy(harness);
  let out = {};
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (e) { out = {}; }
  const err = (r.stderr || '').slice(0, 300);

  t('register(ctx) 注册了 /purge 命令（带参数提示）', () => {
    assert.ok(out.commands, '导入失败：' + err);
    assert.deepStrictEqual(out.commands[0][0], 'purge');
    assert.ok(String(out.commands[0][1]).includes('status'), JSON.stringify(out.commands));
  });

  t('register(ctx) 注册了 purge_status 工具，schema 结构正确', () => {
    assert.ok(out.tools, '导入失败：' + err);
    assert.strictEqual(out.tools[0][0], 'purge_status');
    assert.strictEqual(out.schema_ok, true);
  });

  t('/purge 在 path.json 指向本仓库 CLI 时能给出状态摘要', () => {
    assert.ok(out.status_text, '没有输出：' + err);
    assert.ok(/purge (已开启|未开启|部分生效)/.test(out.status_text), out.status_text);
  });

  t('/purge 遇到未知子命令给用法，不抛栈', () => {
    assert.ok(/未知子命令/.test(out.bad || ''), String(out.bad));
  });

  t('CLI 缺失时给一句人话（不崩）', () => {
    const dir2 = path.join(TMP, 'nopath', 'hermes_purge');
    fs.mkdirSync(dir2, { recursive: true });
    for (const f of ['plugin.yaml', '__init__.py']) {
      fs.copyFileSync(path.join(pluginDir, f), path.join(dir2, f));
    }
    fs.writeFileSync(path.join(dir2, 'path.json'), JSON.stringify({ cli: '/nonexistent/purge.js', node: 'node' }));
    const code = `
import importlib.util
p = ${JSON.stringify(path.join(dir2, '__init__.py'))}
spec = importlib.util.spec_from_file_location('hp2', p, submodule_search_locations=[${JSON.stringify(dir2)}])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m._cmd_purge(''))
`;
    const r2 = runPy(code);
    assert.ok(/找不到 purge CLI/.test(r2.stdout || ''), (r2.stdout || '') + (r2.stderr || '').slice(0, 200));
  });
}

console.log('\n卸载');

t('uninstall 只删插件目录，宿主源码不动', () => {
  const before = fs.readFileSync(path.join(host.home, 'config.yaml'), 'utf8');
  const r = spawnSync(process.execPath, [PURGE, 'plugin', 'uninstall', '--target=' + host.tree],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HERMES_HOME: host.home }), windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(pluginDir), '插件目录还在');
  assert.strictEqual(fs.readFileSync(path.join(host.home, 'config.yaml'), 'utf8'), before, 'config 被动了');
});

t('没装过时 uninstall 也不报错', () => {
  const r = spawnSync(process.execPath, [PURGE, 'plugin', 'uninstall', '--target=' + host.tree],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HERMES_HOME: host.home }), windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('没装过'), r.stdout);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
