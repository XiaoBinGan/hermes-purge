'use strict';
/**
 * lib/v2/conf.js —— 配置层实现（conf kind）
 *
 * 与 impls.js 的文本层并列、互不改写：文本层管「源码整文件替换/插入」，
 * 这一层管「配置文件里加/改键」，语义是「结构化的增量」而不是字符串拼接。
 *
 * 支持（都是零依赖手写，不引 yaml 库）：
 *   yamlEntry   —— 往 cordis.patch.yml 这类「扁平条目列表」里合并一条 config
 *                  （只覆盖声明的键，其它键与注释原样保留；写 cap 标记注释做 sentinel）
 *   yamlTop     —— 顶层标量键（settings.yaml / approval.yaml 这种）
 *   jsonSet     —— JSON 点路径写值（profiles/<p>/package.json 的 dsh.profile.patchReload）
 *   jsonAppend  —— JSON 数组追加去重（bundles 里登记 dsh-purge）
 *   fileWrite   —— 整文件写入（override 清单这种由插件独占的文件）
 *
 * 限制（写清楚）：yamlEntry 只认「顶层 `- id: x` 块」，不处理 `- insert:` 这层嵌套；
 * 也不需要 —— adapter 的 cap 只往 profile 覆盖层写扁平条目。
 */

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

const MARK = '[hermes-purge]';

function abs(target, rel) { return path.resolve(target, rel); }

/**
 * 一个 conf spec 可以只写一个文件，也可以一次写同构的多个文件
 * （典型：web / desktop 两个 profile 的覆盖层要写同样的条目）。
 */
function targets(sp) {
  if (Array.isArray(sp && sp.files) && sp.files.length) return sp.files;
  if (sp && sp.file) return [sp.file];
  return [];
}

function readNorm(file) {
  return platform.readText(file).text.replace(/\r\n/g, '\n');
}

function renderValue(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return String(v);
}

/** 去掉行尾注释与首尾引号，用于「值相等」判定 */
function bare(s) {
  return String(s).replace(/\s+#.*$/, '').trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

/* ───────────── YAML：扁平条目列表 ───────────── */

const ID_RE = /^(\s*)-\s+id:\s*(\S+)\s*$/;

function findBlock(lines, id) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ID_RE);
    if (!m || m[2] !== id) continue;
    const indent = m[1].length;
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end];
      const mm = line.match(ID_RE);
      if (mm && mm[1].length === indent) break;
      // 缩进消失 = 这个列表结束了
      if (line.trim() !== '' && line.length === line.trimStart().length) break;
      end++;
    }
    return { start: i, end, indent };
  }
  return null;
}

function blockHas(blockLines, key, value) {
  const re = new RegExp('^\\s*' + escapeRe(key) + ':\\s*(.*)$');
  for (const line of blockLines) {
    const m = line.match(re);
    if (m && bare(m[1]) === bare(renderValue(value))) return true;
  }
  return false;
}

function blockHasKey(blockLines, key) {
  const re = new RegExp('^\\s*' + escapeRe(key) + ':');
  return blockLines.some((l) => re.test(l));
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sentinelLine(capId) { return '  # ' + MARK + ' ' + capId; }

function configPairs(spec) {
  return Object.keys(spec.config || {}).map((k) => [k, renderValue(spec.config[k])]);
}

function probeYamlEntry(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  if (!fs.existsSync(file)) return { status: 'missing', detail: '文件不存在: ' + sp.file };
  const src = readNorm(file);
  const lines = src.split('\n');
  const blk = findBlock(lines, sp.id);
  if (!blk) return { status: 'pending', detail: '插入条目 ' + sp.id };
  const blockLines = lines.slice(blk.start, blk.end);
  const missing = configPairs(sp).filter(([k, v]) => !blockHas(blockLines, k, v));
  const hasSentinel = blockLines.some((l) => l.includes(MARK + ' ' + capId));
  if (!missing.length && hasSentinel) return { status: 'applied', detail: '条目 ' + sp.id + ' 已就位' };
  if (missing.length) return { status: 'pending', detail: '条目 ' + sp.id + ' 待改: ' + missing.map(([k]) => k).join(',') };
  return { status: 'pending', detail: '条目 ' + sp.id + ' 缺 cap 标记' };
}

function applyYamlEntry(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  const rec = platform.readText(file);
  let src = rec.text.replace(/\r\n/g, '\n');
  let lines = src.split('\n');
  const pairs = configPairs(sp);

  const blk = findBlock(lines, sp.id);
  if (!blk) {
    const block = ['- id: ' + sp.id];
    if (sp.name) block.push('  name: ' + sp.name);
    if (pairs.length) {
      block.push('  config:');
      for (const [k, v] of pairs) block.push('    ' + k + ': ' + v);
    }
    block.push(sentinelLine(capId));
    // 空列表 [] / 空文件 → 直接替换；否则追加
    const body = lines.join('\n');
    if (/^\s*\[\]\s*$/.test(body.trim()) || body.trim() === '') {
      lines = block;
    } else {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines = lines.concat([''], block);
    }
  } else {
    const blockLines = lines.slice(blk.start, blk.end);
    for (const [k, v] of pairs) {
      const re = new RegExp('^(\\s*)' + escapeRe(k) + ':');
      const idx = blockLines.findIndex((l) => re.test(l));
      const line = '    ' + k + ': ' + v;
      if (idx >= 0) blockLines[idx] = line;
      else {
        const ci = blockLines.findIndex((l) => /^\s*config:\s*$/.test(l));
        if (ci >= 0) blockLines.splice(ci + 1, 0, line);
        else { blockLines.push('  config:'); blockLines.push(line); }
      }
    }
    if (!blockLines.some((l) => l.includes(MARK + ' ' + capId))) blockLines.push(sentinelLine(capId));
    lines.splice(blk.start, blk.end - blk.start, ...blockLines);
  }

  const out = lines.join('\n');
  if (out === src) return { changed: false, detail: '内容无变化' };
  platform.writeText(file, out, { bom: rec.bom, eol: rec.eol });
  return { changed: true, detail: 'yamlEntry ' + sp.id + ' 已写入 ' + sp.file };
}

/* ───────────── YAML：顶层标量 ───────────── */

function probeYamlTop(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  if (!fs.existsSync(file)) return { status: 'missing', detail: '文件不存在: ' + sp.file };
  const src = readNorm(file);
  const re = new RegExp('^' + escapeRe(sp.key) + ':[ \\t]*(.*)$', 'm');
  const m = src.match(re);
  if (!m) return { status: 'pending', detail: '注入 ' + sp.key + ': ' + renderValue(sp.value) };
  if (bare(m[1]) === bare(renderValue(sp.value))) return { status: 'applied', detail: sp.key + ': ' + bare(m[1]) };
  return { status: 'pending', detail: sp.key + ': ' + bare(m[1]) + ' → ' + bare(renderValue(sp.value)) };
}

function applyYamlTop(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  const rec = platform.readText(file);
  const src = rec.text.replace(/\r\n/g, '\n');
  const line = sp.key + ': ' + renderValue(sp.value);
  const re = new RegExp('^' + escapeRe(sp.key) + ':[ \\t]*.*$', 'm');
  let out;
  if (re.test(src)) out = src.replace(re, line);
  else out = src.replace(/\n*$/, '\n') + line + '\n';
  if (out === src) return { changed: false, detail: '内容无变化' };
  platform.writeText(file, out, { bom: rec.bom, eol: rec.eol });
  return { changed: true, detail: 'yamlTop ' + sp.key + ' 已写入 ' + sp.file };
}

/* ───────────── JSON ───────────── */

function splitPath(p) { return String(p).split('.').filter(Boolean); }

function getPath(obj, p) {
  let cur = obj;
  for (const k of splitPath(p)) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(obj, p, value) {
  const keys = splitPath(p);
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function parseJsonFile(file, rel) {
  const raw = readNorm(file);
  try { return { ok: true, json: JSON.parse(raw), raw }; } catch (e) {
    return { ok: false, detail: 'JSON 解析失败（' + rel + '）: ' + e.message.slice(0, 80) };
  }
}

function probeJsonSet(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  if (!fs.existsSync(file)) return { status: 'missing', detail: '文件不存在: ' + sp.file };
  const p = parseJsonFile(file, sp.file);
  if (!p.ok) return { status: 'drifted', detail: p.detail };
  const cur = getPath(p.json, sp.path);
  if (deepEqual(cur, sp.value)) return { status: 'applied', detail: sp.path + ' = ' + JSON.stringify(sp.value) };
  return { status: 'pending', detail: sp.path + ' = ' + JSON.stringify(cur === undefined ? null : cur) + ' → ' + JSON.stringify(sp.value) };
}

function applyJsonSet(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  const rec = platform.readText(file);
  const p = parseJsonFile(file, sp.file);
  if (!p.ok) return { changed: false, detail: p.detail };
  setPath(p.json, sp.path, sp.value);
  const out = JSON.stringify(p.json, null, 2) + '\n';
  if (out === p.raw) return { changed: false, detail: '内容无变化' };
  platform.writeText(file, out, { bom: rec.bom, eol: rec.eol });
  return { changed: true, detail: 'jsonSet ' + sp.path + ' 已写入 ' + sp.file };
}

function probeJsonAppend(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  if (!fs.existsSync(file)) return { status: 'missing', detail: '文件不存在: ' + sp.file };
  const p = parseJsonFile(file, sp.file);
  if (!p.ok) return { status: 'drifted', detail: p.detail };
  const arr = getPath(p.json, sp.path);
  if (!Array.isArray(arr)) return { status: 'drifted', detail: sp.path + ' 不是数组' };
  if (arr.includes(sp.value)) return { status: 'applied', detail: sp.path + ' 已含 ' + sp.value };
  return { status: 'pending', detail: sp.path + ' 追加 ' + sp.value };
}

function applyJsonAppend(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  const rec = platform.readText(file);
  const p = parseJsonFile(file, sp.file);
  if (!p.ok) return { changed: false, detail: p.detail };
  const arr = getPath(p.json, sp.path);
  if (!Array.isArray(arr)) return { changed: false, detail: sp.path + ' 不是数组' };
  if (arr.includes(sp.value)) return { changed: false, detail: '已存在，跳过' };
  arr.push(sp.value);
  const out = JSON.stringify(p.json, null, 2) + '\n';
  if (out === p.raw) return { changed: false, detail: '内容无变化' };
  platform.writeText(file, out, { bom: rec.bom, eol: rec.eol });
  return { changed: true, detail: 'jsonAppend ' + sp.path + ' += ' + sp.value };
}

/* ───────────── 整文件写入 ───────────── */

function probeFileWrite(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  if (!fs.existsSync(file)) return { status: 'pending', detail: '新建 ' + sp.file };
  const cur = readNorm(file).replace(/\n+$/, '');
  const want = String(sp.content || '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (cur === want) return { status: 'applied', detail: sp.file + ' 已就位' };
  return { status: 'pending', detail: '覆盖 ' + sp.file };
}

function applyFileWrite(sp, capId, ctx) {
  const file = abs(ctx.target, sp.file);
  const want = String(sp.content || '').replace(/\r\n/g, '\n');
  if (fs.existsSync(file) && readNorm(file).replace(/\n+$/, '') === want.replace(/\n+$/, '')) {
    return { changed: false, detail: '内容无变化' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = fs.existsSync(file) ? platform.readText(file) : { bom: '', eol: '\n' };
  platform.writeText(file, want, { bom: rec.bom, eol: rec.eol });
  return { changed: true, detail: 'fileWrite ' + sp.file };
}

/* ───────────── 分发 ───────────── */

function probeOne(sp, capId, ctx) {
  switch (sp.kind) {
    case 'yamlEntry': return probeYamlEntry(sp, capId, ctx);
    case 'yamlTop': return probeYamlTop(sp, capId, ctx);
    case 'jsonSet': return probeJsonSet(sp, capId, ctx);
    case 'jsonAppend': return probeJsonAppend(sp, capId, ctx);
    case 'fileWrite': return probeFileWrite(sp, capId, ctx);
    default: return { status: 'drifted', detail: '未知 conf kind: ' + sp.kind };
  }
}

function applyOne(sp, capId, ctx) {
  switch (sp.kind) {
    case 'yamlEntry': return applyYamlEntry(sp, capId, ctx);
    case 'yamlTop': return applyYamlTop(sp, capId, ctx);
    case 'jsonSet': return applyJsonSet(sp, capId, ctx);
    case 'jsonAppend': return applyJsonAppend(sp, capId, ctx);
    case 'fileWrite': return applyFileWrite(sp, capId, ctx);
    default: return { changed: false, detail: '未知 conf kind: ' + sp.kind };
  }
}

/** 多文件语义：任一文件缺件 → 整个 impl 记为 missing（不做半写） */
function probeConf(sp, capId, ctx) {
  const list = targets(sp);
  if (!list.length) return { status: 'drifted', detail: 'conf spec 缺 file' };
  let worst = null;
  for (const file of list) {
    const st = probeOne(Object.assign({}, sp, { file }, { files: undefined }), capId, ctx);
    if (st.status === 'applied') continue;
    if (st.status === 'missing' || st.status === 'drifted') return { status: st.status, detail: file + ': ' + st.detail };
    if (!worst) worst = { status: 'pending', detail: file + ': ' + st.detail };
  }
  if (worst) return worst;
  const done = probeOne(Object.assign({}, sp, { file: list[0] }), capId, ctx);
  return { status: 'applied', detail: done.detail };
}

function applyConf(sp, capId, ctx) {
  const list = targets(sp);
  if (!list.length) return { changed: false, detail: 'conf spec 缺 file' };
  const details = [];
  let changed = false;
  for (const file of list) {
    const r = applyOne(Object.assign({}, sp, { file }, { files: undefined }), capId, ctx);
    if (r.changed) changed = true;
    details.push(r.detail);
  }
  return { changed, detail: details.join(' | ') };
}

module.exports = { probeConf, applyConf, targets, findBlock, MARK };
