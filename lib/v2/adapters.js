'use strict';
/**
 * lib/v2/adapters.js —— adapter 注册表（引擎与宿主的唯一接缝）
 *
 * 引擎只认「cap 清单 + 实现分发 + shim 注入 + 验证」这四个动作；
 * 宿主差异（Python 的 AST/site-packages vs Node 的 cordis 插件/预加载）全部收在
 * adapters/<name>/ 里。新增宿主 = 新增一个目录 + 在下面登记一行，引擎不改。
 *
 * 探测规则（detect）：
 *   hermes → 目标里有 hermes_cli/ 且 agent/                    （Hermes Agent 源码根）
 *   dsh    → 目标里有 cordis.patch.yml，或 plugins/ + package.json 里出现 dsh
 *             （DeepSeek Harness 的 $DSH_HOME 布局）
 *   都不中 → null，由调用方报错并提示 --adapter
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function readPkgName(dir) {
  try {
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) return '';
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    return typeof json.name === 'string' ? json.name : '';
  } catch (e) { return ''; }
}

/** 目标里所有 package.json 的 name 是否提到 dsh（只看根 + plugins/*，不深搜） */
function mentionsDsh(dir) {
  if (/dsh/i.test(readPkgName(dir))) return true;
  const plugins = path.join(dir, 'plugins');
  if (!isDir(plugins)) return false;
  let names = [];
  try { names = fs.readdirSync(plugins); } catch (e) { return false; }
  for (const n of names) {
    if (/dsh/i.test(n)) return true;
    if (/dsh/i.test(readPkgName(path.join(plugins, n)))) return true;
  }
  return false;
}

/* ───────────── 注册表 ───────────── */

const REGISTRY = {
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent（Python 宿主）',
    layout: 'hermes_cli/ + agent/',
    detect: (target) => isDir(path.join(target, 'hermes_cli')) && isDir(path.join(target, 'agent')),
    load: () => require(path.join(ROOT, 'adapters', 'hermes', 'index.js')),
  },
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness（Node / cordis 插件宿主）',
    layout: 'cordis.patch.yml，或 plugins/ + package.json 含 dsh',
    detect: (target) => fs.existsSync(path.join(target, 'cordis.patch.yml'))
      || (isDir(path.join(target, 'plugins')) && mentionsDsh(target)),
    load: () => require(path.join(ROOT, 'adapters', 'dsh', 'index.js')),
  },
};

/** 按 id 取 adapter（已加载）。未知 id → 抛错并给可用清单 */
function get(id) {
  const key = String(id || '').toLowerCase();
  const entry = REGISTRY[key];
  if (!entry) {
    const err = new Error('未知 adapter: ' + id + '（可用：' + list().join(' | ') + '）');
    err.code = 'unknown-adapter';
    throw err;
  }
  const mod = entry.load();
  // 注册表是元数据来源，adapter 模块只需要实现动作
  return Object.assign(Object.create(null), mod, {
    id: entry.id, label: entry.label, layout: entry.layout,
  });
}

/** 目录探测：返回 adapter 名，认不出返回 null */
function detect(target) {
  if (!target || !fs.existsSync(target)) return null;
  for (const key of Object.keys(REGISTRY)) {
    let hit = false;
    try { hit = !!REGISTRY[key].detect(target); } catch (e) { hit = false; }
    if (hit) return key;
  }
  return null;
}

function list() { return Object.keys(REGISTRY); }

/**
 * 决定这次跑哪个 adapter。
 *   opts.name  —— --adapter=xxx；'auto' / 空 → 探测
 *   opts.target —— 目标目录（探测用）
 * 返回 { id, source: 'flag' | 'detect' | 'default', adapter }
 * 探测不到时的行为：
 *   undetected='default-hermes'（库调用/向后兼容，缺省）→ 落回 hermes
 *   undetected='throw'（CLI 用）→ 抛错，错误信息里带 --adapter 提示
 */
function resolve(opts) {
  const o = opts || {};
  const name = o.name === undefined || o.name === true ? '' : String(o.name).trim();
  if (name && name !== 'auto') {
    const adapter = get(name);
    return { id: adapter.id, source: 'flag', adapter };
  }
  const hit = detect(o.target);
  if (hit) return { id: hit, source: 'detect', adapter: get(hit) };

  // 向后兼容：老调用方（1.x 语义、无 target 的 buildCaps()）拿到的必须是 hermes
  if (!o.target || o.undetected !== 'throw') {
    return { id: 'hermes', source: 'default', adapter: get('hermes') };
  }

  const err = new Error('认不出目标的宿主类型: ' + o.target +
    '\n  期望布局：' + list().map((k) => k + ' = ' + REGISTRY[k].layout).join('；') +
    '\n  用 --adapter=hermes|dsh 指定。');
  err.code = 'adapter-undetected';
  throw err;
}

/** 帮助文本用 */
function describe() {
  return list().map((k) => '    ' + k.padEnd(8) + REGISTRY[k].label).join('\n');
}

module.exports = { REGISTRY, get, detect, list, resolve, describe, mentionsDsh };
