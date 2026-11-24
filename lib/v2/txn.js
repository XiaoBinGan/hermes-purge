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
/** 归宿主/用户所有的可变文件（被重写序列化是常态，不算「被外部改过」） */
const VOLATILE_RE = /(^|\/)config\.ya?ml$|(^|\/)\.env$/;
const isVolatile = (rec) => rec.volatile === true || VOLATILE_RE.test(String(rec.rel));

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

/** 快照清单，按 seq（无 seq 的老快照按 id）升序 —— 撤销栈要靠这个顺序 */
function orderedManifests(target) {
  const list = listSnapshots(target).map((id) => readManifest(target, id)).filter(Boolean);
  return list.sort((a, b) => {
    const sa = typeof a.seq === 'number' ? a.seq : 0;
    const sb = typeof b.seq === 'number' ? b.seq : 0;
    if (sa !== sb) return sa - sb;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** 开始事务：把将要改的文件整体快照下来（只读，不动目标） */
function begin(target, rels, opts) {
  const volatileSet = new Set(((opts && opts.volatile) || []).map((r) => r.replace(/\\/g, '/')));
  // 同一毫秒内两次 apply 会撞同一个 id → 加随机后缀，保证快照永不互相覆盖
  const ts = new Date().toISOString().replace(/[:.]/g, '-') + '-' +
    crypto.randomBytes(3).toString('hex');
  const dir = path.join(stateDir(target), 'snap', ts);
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const files = [];
  for (const rel of rels) {
    const abs = path.resolve(target, rel);
    const rec = { rel, abs, existed: fs.existsSync(abs), volatile: volatileSet.has(rel.replace(/\\/g, '/')) };
    if (rec.existed) {
      rec.before = sha256(abs);
      const dest = path.join(filesDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    files.push(rec);
  }
  // seq 单调递增：id 里有随机后缀，不能靠 id 排序（同毫秒两次 apply 会乱序）
  let seq = 1;
  for (const id of listSnapshots(target)) {
    const m = readManifest(target, id);
    if (m && typeof m.seq === 'number' && m.seq >= seq) seq = m.seq + 1;
  }
  const snap = { id: ts, seq, target, dir, files, startedAt: new Date().toISOString() };
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
  const all = orderedManifests(target);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].ok && !all[i].aborted) return all[i];
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
  const all = orderedManifests(target).filter((m) => m.ok && !m.aborted);
  if (!all.length) return { ok: false, reason: 'no-manifest' };

  let targets;
  if (o.id) {
    const idx = all.findIndex((m) => m.id === o.id);
    if (idx < 0) return { ok: false, reason: 'snapshot-not-found' };
    targets = all.slice(idx);           // 从旧到新
  } else if (o.all === false) {
    targets = [all[all.length - 1]];    // --one：只撤最后一层（调试用）
  } else {
    // 默认撤全部：用户说「revert」的意思是「把补丁都退掉」，不是「退掉一次 apply」。
    // 之前只撤最后一层，历史上攒了 17 层后按一次几乎看不出变化。
    targets = all.slice();
  }
  targets = targets.reverse();          // LIFO：先撤最新的

  const restored = [];
  const drifted = [];
  const skipped = [];
  for (const man of targets) {
    for (const rec of man.files) {
      if (!rec.existed) {
        if (fs.existsSync(rec.abs)) { fs.unlinkSync(rec.abs); restored.push(rec.rel + ' (deleted)'); }
        continue;
      }
      const cur = fs.existsSync(rec.abs) ? sha256(rec.abs) : null;
      if (cur === rec.before) continue;                       // 已经是原件
      if (isVolatile(rec) && !o.force) { skipped.push(rec.rel); continue; }  // 配置归宿主，别覆盖
      // 文件被删了（我们自己的 shim 卸载、或用户删的）：没有「外部改过」可言，直接从快照放回。
      if (cur === null) {
        const src0 = path.join(man.dir, 'files', rec.rel);
        if (fs.existsSync(src0)) {
          fs.copyFileSync(src0, rec.abs);
          if (sha256(rec.abs) === rec.before) restored.push(rec.rel);
          else drifted.push(rec.rel + ' (hash mismatch after restore)');
        } else {
          drifted.push(rec.rel + ' (snapshot missing)');
        }
        continue;
      }
      if (cur !== rec.after && !o.force) { drifted.push(rec.rel); continue; }
      const src = path.join(man.dir, 'files', rec.rel);
      if (!fs.existsSync(src)) { drifted.push(rec.rel + ' (snapshot missing)'); continue; }
      fs.copyFileSync(src, rec.abs);
      if (sha256(rec.abs) === rec.before) restored.push(rec.rel);
      else drifted.push(rec.rel + ' (hash mismatch after restore)');
    }
    audit(target, { event: 'revert', id: man.id, restored: restored.length, drifted: drifted.length });
  }
  if (skipped.length) audit(target, { event: 'revert-skip', files: skipped });
  return { ok: drifted.length === 0, restored, drifted, skipped, id: targets[targets.length - 1].id };
}

/** revert 会撤销哪些相对路径（供 shim 卸载避开这些文件，避免「先删后校验」打架） */
function coveredPaths(target, opts) {
  const o = opts || {};
  const all = orderedManifests(target).filter((m) => m.ok && !m.aborted);
  if (!all.length) return new Set();
  let targets;
  if (o.id) {
    const idx = all.findIndex((m) => m.id === o.id);
    targets = idx < 0 ? [] : all.slice(idx);
  } else {
    targets = [all[all.length - 1]];
  }
  const out = new Set();
  // 统一成 / 分隔：manifest 里记的是相对路径，Windows 上是反斜杠，
  // 而 shim.uninstall 用 path.relative(...).replace(/\\/g,'/') 构造 skip 集合。
  // 不归一化就永远 skip 不到 → shim 被先删掉，revert 再把它当成「外部改过」报 drifted
  // （实测 revert 输出「以下文件被外部改过：_hermes_purge_shim.py / _hermes_purge.pth」）。
  for (const m of targets) for (const rec of m.files) out.add(String(rec.rel).replace(/\\/g, '/'));
  return out;
}

function audit(target, entry) {
  const dir = stateDir(target);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry));
  fs.appendFileSync(path.join(dir, 'audit.jsonl'), line + '\n', 'utf8');
}

/* ───────────── 体检 ───────────── */

/**
 * 体检。opts 是可选的 adapter 扩展（默认不传 = hermes 全量检查，行为不变）：
 *   skip  —— 不适用的检查名（DSH 上没有 python / site-packages / 1.x .bak）
 *   extra —— adapter 自己的检查项
 */
function doctor(target, opts) {
  const o = opts || {};
  const skip = new Set(o.skip || []);
  const report = { target, checks: [] };
  const add = (name, ok, detail) => {
    if (skip.has(name)) return;
    report.checks.push({ name, ok, detail });
  };

  const man = latestManifest(target);
  add('latest manifest', !!man, man ? 'id=' + man.id + '（' + man.files.length + ' 个文件）' : '没有 apply 记录');

  if (man) {
    const hard = [];
    const soft = [];
    for (const rec of man.files) {
      const cur = fs.existsSync(rec.abs) ? sha256(rec.abs) : null;
      if (cur === rec.after) continue;
      // 配置文件归宿主/用户所有：宿主会重写序列化（换行、键顺序、注释），哈希必然变，
      // 但语义可能完全一致。所以这类不算「被外部改过」，单独提示语义另行校验。
      (isVolatile(rec) ? soft : hard).push(rec.rel);
    }
    add('文件哈希', hard.length === 0,
      hard.length ? '被外部改过：' + hard.slice(0, 5).join(', ') : '代码文件与 apply 后一致');
    if (soft.length) {
      add('配置文件重写', true,
        soft.join(', ') + ' 被宿主/你重写过（语义另由配置层 cap 校验，不算异常）');
    }
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
  const sps = platform.sitePackages(target, opts && opts.py);
  const shim = sps.map((sp) => path.join(sp, '_hermes_purge.pth')).filter((p) => fs.existsSync(p));
  add('shim 注入', shim.length > 0, shim.length ? shim.join(', ') : '未注入（纯源码层）');

  // 运行时生效：装了 shim ≠ 它被加载过。shim 每跑一轮会往 metrics.jsonl 写一条带 surface 的记录，
  // 这里从后往前找最后一条 —— 「补丁全绿但问了不回答」第一步就看这个：
  // 没有 turn 记录 = 宿主根本没在打过补丁的进程里跑过（重启 dashboard/桌面端后再问一句）。
  const mfile = path.join(target, '.hermes-purge', 'v2', 'metrics.jsonl');
  let lastTurn = null;
  try {
    const lines = fs.readFileSync(mfile, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && !lastTurn; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j && j.surface) lastTurn = j;
      } catch (e) { /* 坏行跳过 */ }
    }
  } catch (e) { /* 文件不存在 = 一轮都没跑过 */ }
  const turnTime = lastTurn && (lastTurn.ts || lastTurn.at);
  const refusals = lastTurn && lastTurn.refusals;
  const approval = lastTurn && lastTurn.approval;
  add('运行时生效', true,
    lastTurn
      ? '最近一轮 ' + (turnTime || '?') + ' · surface=' + lastTurn.surface +
        (lastTurn.model ? ' · model=' + lastTurn.model : '') +
        (approval && approval.mode ? ' · approval=' + approval.mode : '') +
        (refusals ? ' · 拒答重采样 ' + (refusals.nudges || 0) + ' 次' + (refusals.hit ? '（命中过拒答）' : '') : '') +
        (lastTurn.ok === false ? ' · 该轮宿主抛了异常' : '')
      : '还没有任何 turn 记录 —— shim 已注入但宿主没在打过补丁的进程里跑过；'
        + '重启 dashboard / 桌面端后随便问一句，再看这里');

  for (const c of o.extra || []) report.checks.push(c);

  report.ok = report.checks.every((c) => c.ok);
  return report;
}

/** 读审计日志（最近 limit 条，新的在后） */
function readAudit(target, limit) {
  const p = path.join(stateDir(target), 'audit.jsonl');
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  const rows = [];
  for (const l of lines) { try { rows.push(JSON.parse(l)); } catch (e) { /* 忽略坏行 */ } }
  return limit ? rows.slice(-limit) : rows;
}

module.exports = { sha256, stateDir, readAudit, isVolatile, VOLATILE_RE, begin, commit, abort, revert, doctor, latestManifest, listSnapshots, orderedManifests, audit, coveredPaths };