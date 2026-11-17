'use strict';
/**
 * lib/v2/txn.js —— 事务：快照 / manifest / 原子回滚 / 体检
 *
 * 与 dsh-purge 的 .bak 相比多出来的三件事：
 *   1. 快照是「一次 apply 一个目录」，多版本共存，不会被下一次 apply 覆盖
 *   2. manifest 记 before/after 双哈希，回滚前先验证「当前文件 == 我上次写完的样子」
 *      —— 用户手改过就拒绝覆盖（--force 才强上）
 *   3. 回滚后逐字节校验，能证明「退干净了」
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const platform = require('./platform');

const STATE_DIRNAME = '.hermes-purge';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stateDir(target) {
  return path.join(target, STATE_DIRNAME, 'v2');
}

function listSnapshots(target) {
  const dir = path.join(stateDir(target), 'snap');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort();
}

/** 开始事务：把将要改的文件整体快照下来（只读，不动目标） */
function begin(target, rels) {
  // 同一毫秒内两次 apply 会撞同一个 id → 加随机后缀，保证快照永不互相覆盖
  const ts = new Date().toISOString().replace(/[:.]/g, '-') + '-' +
    crypto.randomBytes(3).toString('hex');
  const dir = path.join(stateDir(target), 'snap', ts);
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const files = [];
  for (const rel of rels) {
    const abs = path.resolve(target, rel);
    const rec = { rel, abs, existed: fs.existsSync(abs) };
    if (rec.existed) {
      rec.before = sha256(abs);
      const dest = path.join(filesDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    files.push(rec);
  }
  const snap = { id: ts, target, dir, files, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(snap, null, 2), 'utf8');
  return snap;
}

/** 结束事务：补 after 哈希，标记成功 */
function commit(snap, extra) {
  for (const rec of snap.files) {
    rec.after = fs.existsSync(rec.abs) ? sha256(rec.abs) : null;
    rec.changed = rec.existed ? rec.before !== rec.after : rec.after !== null;
  }
  Object.assign(snap, extra || {}, { finishedAt: new Date().toISOString(), ok: true });
  fs.writeFileSync(path.join(snap.dir, 'manifest.json'), JSON.stringify(snap, null, 2), 'utf8');
  fs.writeFileSync(path.join(stateDir(snap.target), 'latest'), snap.id, 'utf8');
  audit(snap.target, { event: 'apply', id: snap.id,
    changed: snap.files.filter((f) => f.changed).length });
  return snap;
}

/** 放弃事务：用快照把已改的文件还回去 */
function abort(snap) {
  let restored = 0;
  for (const rec of snap.files) {
    if (!rec.existed) { continue; }
    const src = path.join(snap.dir, 'files', rec.rel);
    if (fs.existsSync(src)) { fs.copyFileSync(src, rec.abs); restored++; }
  }
  fs.writeFileSync(path.join(snap.dir, 'manifest.json'),
    JSON.stringify(Object.assign(snap, { aborted: true }), null, 2), 'utf8');
  return restored;
}

function readManifest(target, id) {
  const dir = path.join(stateDir(target), 'snap', id);
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function latestManifest(target) {
  const latestFile = path.join(stateDir(target), 'latest');
  if (fs.existsSync(latestFile)) {
    const id = fs.readFileSync(latestFile, 'utf8').trim();
    const m = readManifest(target, id);
    if (m) return m;
  }
  const ids = listSnapshots(target);
  for (let i = ids.length - 1; i >= 0; i--) {
    const m = readManifest(target, ids[i]);
    if (m && m.ok && !m.aborted) return m;
  }
  return null;
}

/**
 * 回滚。按「撤销栈」语义：指定 id 时，从最新一路 undo 到该 id（含），顺序 LIFO。
 * 返回 {restored, drifted}；drifted = 当前哈希既不等于 after 也不等于 before
 * （说明这个文件在 apply 之后又被别的补丁或人手改过）
 */
function revert(target, opts) {
  const o = opts || {};
  const all = listSnapshots(target).map((id) => readManifest(target, id)).filter((m) => m && m.ok && !m.aborted);
  if (!all.length) return { ok: false, reason: 'no-manifest' };

  let targets;
  if (o.id) {
    const idx = all.findIndex((m) => m.id === o.id);
    if (idx < 0) return { ok: false, reason: 'snapshot-not-found' };
    targets = all.slice(idx);           // 从旧到新
  } else {
    targets = [all[all.length - 1]];
  }
  targets = targets.reverse();          // LIFO：先撤最新的

  const restored = [];
  const drifted = [];
  for (const man of targets) {
    for (const rec of man.files) {
      if (!rec.existed) {
        if (fs.existsSync(rec.abs)) { fs.unlinkSync(rec.abs); restored.push(rec.rel + ' (deleted)'); }
        continue;
      }
      const cur = fs.existsSync(rec.abs) ? sha256(rec.abs) : null;
      if (cur === rec.before) continue;                       // 已经是原件
      if (cur !== rec.after && !o.force) { drifted.push(rec.rel); continue; }
      const src = path.join(man.dir, 'files', rec.rel);
      if (!fs.existsSync(src)) { drifted.push(rec.rel + ' (snapshot missing)'); continue; }
      fs.copyFileSync(src, rec.abs);
      if (sha256(rec.abs) === rec.before) restored.push(rec.rel);
      else drifted.push(rec.rel + ' (hash mismatch after restore)');
    }
    audit(target, { event: 'revert', id: man.id, restored: restored.length, drifted: drifted.length });
  }
  return { ok: drifted.length === 0, restored, drifted, id: targets[targets.length - 1].id };
}

/** revert 会撤销哪些相对路径（供 shim 卸载避开这些文件，避免「先删后校验」打架） */
function coveredPaths(target, opts) {
  const o = opts || {};
  const all = listSnapshots(target).map((id) => readManifest(target, id)).filter((m) => m && m.ok && !m.aborted);
  if (!all.length) return new Set();
  let targets;
  if (o.id) {
    const idx = all.findIndex((m) => m.id === o.id);
    targets = idx < 0 ? [] : all.slice(idx);
  } else {
    targets = [all[all.length - 1]];
  }
  const out = new Set();
  for (const m of targets) for (const rec of m.files) out.add(rec.rel);
  return out;
}

function audit(target, entry) {
  const dir = stateDir(target);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry));
  fs.appendFileSync(path.join(dir, 'audit.jsonl'), line + '\n', 'utf8');
}

/* ───────────── 体检 ───────────── */

function doctor(target) {
  const report = { target, checks: [] };
  const add = (name, ok, detail) => report.checks.push({ name, ok, detail });

  const man = latestManifest(target);
  add('latest manifest', !!man, man ? 'id=' + man.id + '（' + man.files.length + ' 个文件）' : '没有 apply 记录');

  if (man) {
    const drifted = [];
    for (const rec of man.files) {
      const cur = fs.existsSync(rec.abs) ? sha256(rec.abs) : null;
      if (cur !== rec.after) drifted.push(rec.rel);
    }
    add('文件哈希', drifted.length === 0,
      drifted.length ? '被外部改过：' + drifted.slice(0, 5).join(', ') : '与 apply 后一致');
  }

  // 残留临时文件
  const tmp = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!platform.SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.name.includes('.purge-tmp-')) tmp.push(path.join(dir, e.name));
    }
  };
  walk(target);
  add('临时文件残留', tmp.length === 0, tmp.length ? tmp.slice(0, 5).join(', ') : '无');

  // 1.x 的 .bak 是否还在（说明有人混用两代引擎）
  const baks = [];
  const walk2 = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!platform.SKIP_DIRS.has(e.name)) walk2(path.join(dir, e.name)); }
      else if (e.name.endsWith('.hermes-purge.bak')) baks.push(path.join(dir, e.name));
    }
  };
  walk2(target);
  add('1.x 备份共存', true, baks.length ? baks.length + ' 个 .bak（1.x 留下，v2 不依赖它们）' : '无');

  // python 解释器
  const py = platform.findPython(target);
  add('宿主 python', !!py, py || '找不到 venv python（AST/sh行 层不可用，退回文本层）');

  // shim
  const sps = platform.sitePackages(target);
  const shim = sps.map((sp) => path.join(sp, '_hermes_purge.pth')).filter((p) => fs.existsSync(p));
  add('shim 注入', shim.length > 0, shim.length ? shim.join(', ') : '未注入（纯源码层）');

  report.ok = report.checks.every((c) => c.ok);
  return report;
}

module.exports = { sha256, stateDir, begin, commit, abort, revert, doctor, latestManifest, listSnapshots, audit, coveredPaths };