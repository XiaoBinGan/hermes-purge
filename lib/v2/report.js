'use strict';
/**
 * lib/v2/report.js —— 生成单文件 HTML 状态报告
 *
 * 动机：用 Hermes 的时候，没人知道补丁到底开没开、开在哪一层、什么时候会失效。
 * 命令行 `purge status` 信息是全的，但没人会天天敲。
 *
 * 原则：
 *   1. 单文件、零依赖、离线可开（可以直接发给别人看）
 *   2. 只搬真实数据（status / doctor / metrics / audit），拿不到就写 n/a
 *   3. 必须写明生成时间 —— 静态报告里的「实时」是假的
 */

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LAYER_LABEL = { code: '代码层', config: '配置层', prompt: '提示词层' };
const STATUS_META = {
  applied: { label: '已生效', color: '#22c55e' },
  pending: { label: '待应用', color: '#eab308' },
  drifted: { label: '不可用', color: '#ef4444' },
  missing: { label: '缺文件', color: '#94a3b8' },
};

/**
 * @param {object} d
 *  {target, adapter, version, python, rows, doctor, stats, audit, generatedAt}
 */
function render(d) {
  const rows = d.rows || [];
  const by = (s) => rows.filter((r) => r.status === s).length;
  const total = rows.length;
  const applied = by('applied');
  const pending = by('pending');
  const drifted = by('drifted');
  const healthy = total > 0 && applied === total;

  const verdict = total === 0 ? '未开启（没有能力记录）'
    : (healthy ? '已开启（全部生效）' : (applied === 0 ? '未开启' : '部分生效'));
  const verdictColor = total === 0 ? '#94a3b8'
    : (healthy ? '#22c55e' : (applied === 0 ? '#ef4444' : '#eab308'));

  const implCount = {};
  for (const r of rows) if (r.impl) implCount[r.impl] = (implCount[r.impl] || 0) + 1;

  const checks = (d.doctor && d.doctor.checks) || [];
  const stats = d.stats || {};
  const audit = (d.audit || []).slice(-12).reverse();

  const layerGroups = {};
  for (const r of rows) (layerGroups[r.layer] = layerGroups[r.layer] || []).push(r);

  const rowHtml = (r) => {
    const m = STATUS_META[r.status] || { label: r.status, color: '#94a3b8' };
    return `<tr>
      <td class="id">${esc(r.id)}</td>
      <td><span class="dot" style="background:${m.color}"></span>${esc(m.label)}</td>
      <td><span class="impl">${esc(r.impl || '—')}</span></td>
      <td class="cap">${esc(r.cap)}</td>
      <td class="detail">${esc(r.detail || '')}</td>
    </tr>`;
  };

  const sections = Object.keys(layerGroups).map((layer) => `
    <h2>${esc(LAYER_LABEL[layer] || layer)} <span class="muted">${layerGroups[layer].length} 条</span></h2>
    <table>
      <thead><tr><th>ID</th><th>状态</th><th>实现层</th><th>行为</th><th>说明</th></tr></thead>
      <tbody>${layerGroups[layer].map(rowHtml).join('')}</tbody>
    </table>`).join('');

  const checkHtml = checks.map((c) => `
    <li class="${c.ok ? 'ok' : 'bad'}"><span>${c.ok ? '✔' : '✖'}</span>
      <b>${esc(c.name)}</b><em>${esc(c.detail || '')}</em></li>`).join('');

  const auditHtml = audit.length ? audit.map((a) => `
    <li><time>${esc(a.at || '')}</time><b>${esc(a.event || '')}</b>
      <em>${esc(a.restored !== undefined ? '恢复 ' + a.restored + ' 个文件' : (a.changed !== undefined ? '改写 ' + a.changed : ''))}</em></li>`).join('')
    : '<li class="muted">还没有 apply / revert 记录</li>';

  const statCell = (k, v, hint) => `
    <div class="kpi"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div>
      ${hint ? `<div class="h">${esc(hint)}</div>` : ''}</div>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hermes-purge 状态 · ${esc(d.adapter)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.55 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 26px 0 8px; text-transform: none; }
  .muted { color: #94a3b8; font-weight: 400; }
  .verdict { display: flex; align-items: baseline; gap: 12px; padding: 16px 18px; border-radius: 12px;
             background: color-mix(in srgb, ${verdictColor} 12%, transparent);
             border: 1px solid color-mix(in srgb, ${verdictColor} 45%, transparent); }
  .verdict .big { font-size: 22px; font-weight: 700; color: ${verdictColor}; }
  .verdict .sub { color: #64748b; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
  .kpi { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 10px; padding: 12px; }
  .kpi .v { font-size: 20px; font-weight: 700; }
  .kpi .k { font-size: 12px; color: #64748b; margin-top: 2px; }
  .kpi .h { font-size: 11px; color: #94a3b8; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); }
  th { font-weight: 600; color: #64748b; font-size: 12px; }
  td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #64748b; width: 66px; }
  td.detail { color: #94a3b8; font-size: 12px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .impl { font-family: ui-monospace, monospace; font-size: 12px; padding: 1px 6px; border-radius: 999px;
          border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
  ul.checks { list-style: none; padding: 0; margin: 0; }
  ul.checks li { padding: 5px 0; border-bottom: 1px dashed color-mix(in srgb, CanvasText 10%, transparent); }
  ul.checks li span { margin-right: 8px; }
  ul.checks li.ok span { color: #22c55e; }
  ul.checks li.bad span { color: #ef4444; }
  ul.checks em, ul.audit em { color: #94a3b8; font-style: normal; margin-left: 8px; font-size: 12px; }
  ul.audit { list-style: none; padding: 0; margin: 0; font-size: 13px; }
  ul.audit time { color: #94a3b8; font-family: ui-monospace, monospace; font-size: 11px; margin-right: 10px; }
  footer { margin-top: 30px; color: #94a3b8; font-size: 12px; border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent); padding-top: 12px; }
  code { font-family: ui-monospace, monospace; background: color-mix(in srgb, CanvasText 8%, transparent);
         padding: 1px 5px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { body { background: #0b1020; color: #e2e8f0; } }
</style></head>
<body><main>
  <h1>hermes-purge 状态报告</h1>
  <div class="muted">宿主 <b>${esc(d.adapter)}</b> · ${esc(d.target)}</div>

  <div class="verdict" style="margin-top:16px">
    <div class="big">${esc(verdict)}</div>
    <div class="sub">${applied}/${total} 条能力生效 · 待应用 ${pending} · 不可用 ${drifted}</div>
  </div>

  <div class="kpis">
    ${statCell('生效 / 总数', applied + ' / ' + total)}
    ${statCell('实现层分布', Object.entries(implCount).map(([k, v]) => k + ' ' + v).join(' · ') || '—',
      'AST 抗搬家 · shim 抗版本 · text 兼容层')}
    ${statCell('对话轮次', stats.turns === undefined ? 'n/a' : stats.turns,
      stats.turns ? '拒答命中 ' + (stats.refusalHits || 0) + ' 次' : '还没有轮次数据')}
    ${statCell('版本 / 宿主版本', esc(d.version) + ' / ' + esc(d.hostVersion || 'n/a'))}
  </div>

  <h2>健康检查 <span class="muted">doctor</span></h2>
  <ul class="checks">${checkHtml || '<li class="muted">没有检查结果</li>'}</ul>

  <h2>能力明细 <span class="muted">每条走哪层实现</span></h2>
  ${sections || '<p class="muted">没有能力记录</p>'}

  <h2>最近动作 <span class="muted">audit</span></h2>
  <ul class="audit">${auditHtml}</ul>

  <footer>
    生成于 ${esc(d.generatedAt)} · 这份报告是静态快照，重跑 <code>purge report</code> 才会更新<br>
    回滚：<code>purge revert</code> · 复检：<code>purge verify --level=2</code> · 卸载：<code>purge uninstall</code>
  </footer>
</main></body></html>`;
}

function write(file, html) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return { file, bytes: Buffer.byteLength(html) };
}

module.exports = { render, write };
