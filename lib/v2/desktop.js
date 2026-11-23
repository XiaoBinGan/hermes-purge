'use strict';
/**
 * lib/v2/desktop.js —— 把状态面板挂进 Hermes 桌面端（Electron）的侧边栏
 *
 * 为什么这么做：Hermes 桌面端是打包好的 React SPA（app.asar.unpacked/dist），
 * 没有 UI 扩展点，插件系统也只能注册工具/命令。要做到「和原生一样、排在大定时任务
 * 后面」，只有两条路：
 *   a) 改源码重新构建 —— 本机缺 @rolldown/plugin-babel，构建不通；且每次升级要重做
 *   b) 往 index.html 里加一行 <script>，用 DOM 注入把入口插进侧边栏（本文件的方案）
 * 选 b：只动一个文件的一行 + 自带两个文件，卸载 = 还原 + 删文件，升级后重跑 install 即可。
 *
 * 边界（如实写）：
 *   - 是 DOM 注入，不是编译进 bundle：命令面板/键盘导航里不会出现这个入口
 *   - Hermes 升级会替换 dist，需要重跑 `purge desktop install`
 *   - 面板内容是一份内联快照（srcdoc），不会自己刷新；`purge desktop sync` 重新生成
 */

const fs = require('fs');
const path = require('path');

const PANEL_FILE = 'purge-panel.js';
const BAK_SUFFIX = '.purge-bak';
function scriptTag(fingerprint) {
  // Electron 会缓存 file:// 的脚本；带上内容指纹，换了内容就换 URL，绝不跑旧脚本
  return '<script defer src="./purge-panel.js?v=' + fingerprint + '"></script>';
}

/** 找出所有可能的 renderer dist（打包版优先，其次开发构建） */
function findDists(target) {
  const out = [];
  const push = (dir) => {
    const idx = path.join(dir, 'index.html');
    if (fs.existsSync(idx) && !out.includes(dir)) out.push(dir);
  };
  const rel = path.join(target, 'apps', 'desktop');
  push(path.join(rel, 'dist')); // 开发构建

  const relDir = path.join(rel, 'release');
  if (fs.existsSync(relDir)) {
    for (const name of fs.readdirSync(relDir)) {
      const base = path.join(relDir, name);
      push(path.join(base, 'Hermes.app', 'Contents', 'Resources', 'app.asar.unpacked', 'dist')); // mac
      push(path.join(base, 'resources', 'app.asar.unpacked', 'dist'));                            // win/linux
      push(path.join(base, 'resources', 'app', 'dist'));
    }
  }
  return out;
}

/**
 * 生成注入脚本：在侧边栏最后一个导航项（源码顺序是 skills→messaging→artifacts→cron）
 * 后面插一个入口，点开是一个覆盖层，里面用 srcdoc 渲染状态报告。
 */
function panelSource(reportHtml, meta) {
  const payload = JSON.stringify({
    report: reportHtml,
    version: (meta && meta.version) || '',
    generatedAt: (meta && meta.generatedAt) || '',
    // 本地控制服务（purge serve）：面板上的「启用/停用/体检/刷新」靠它执行
    control: { port: (meta && meta.controlPort) || 9123, token: (meta && meta.controlToken) || '' },
  });
  return `/* hermes-purge 桌面面板（由 purge desktop install 生成，别手改） */
(function () {
  if (window.__HERMES_PURGE_PANEL__) return;
  window.__HERMES_PURGE_PANEL__ = true;
  var DATA = ${payload};
  var MARK = 'data-purge-nav';
  var NL = String.fromCharCode(10);
  // 飞镖：镖身 + 镖尖 + 尾翼
  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 14l3.2-3.2"/><path d="M5.2 10.8L12 4"/><path d="M12 4l2.2.6-.6 2.2z"/><path d="M8.4 3.2L10 1.6l1.4 1.4-1.6 1.6"/><path d="M3.2 8.4L1.6 10l1.4 1.4 1.6-1.6"/></svg>';

  // 侧边栏导航是 shadcn 的 SidebarMenu：<ul class="… gap-px"><li><button>…
  // 关键：**不读布局**（不调 getBoundingClientRect）。之前那版在 MutationObserver 里读布局，
  // 聊天流式输出时每帧都强制同步布局 → renderer 卡死 → Electron 直接 crash（日志里
  // "webContents became unresponsive" + "render-process-gone reason=crashed"）。
  function navList() {
    var sel = ':scope > li > button, :scope > li > a, :scope > button, :scope > a';
    var direct = document.querySelector('ul.gap-px');
    if (direct && direct.querySelectorAll(sel).length >= 3) return direct;
    var lists = document.querySelectorAll('aside ul, nav ul, [data-sidebar] ul');
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].querySelectorAll(sel).length >= 3) return lists[i];
    }
    var any = document.querySelectorAll('ul');
    for (var j = 0; j < any.length; j++) {
      if (any[j].querySelectorAll(sel).length >= 3) return any[j];
    }
    return null;
  }

  function buildButton(proto) {
    var b = proto.cloneNode(true);
    b.setAttribute(MARK, '1');
    b.setAttribute('role', 'button');
    b.setAttribute('title', 'hermes-purge 状态');
    b.setAttribute('aria-label', 'hermes-purge 状态');
    b.removeAttribute('href');
    b.removeAttribute('aria-disabled');
    b.removeAttribute('data-tour');
    b.removeAttribute('data-state');
    b.removeAttribute('data-hermes-context-menu-trigger');
    b.setAttribute('data-tour', 'sidebar-nav-purge');
    // 克隆来的行里图标不止一种：<svg> 和 codicon（<i class="codicon codicon-watch">）都有，
    // 还可能带尾部小箭头。全部清掉，再在第一个图标原来的位置放飞镖 —— 否则「手表」会留着。
    var icons = b.querySelectorAll('svg, .codicon, i[class*="codicon"]');
    var anchorParent = null;
    var anchorNext = null;
    if (icons.length) {
      anchorParent = icons[0].parentNode;
      anchorNext = icons[0].nextSibling;
      for (var k = icons.length - 1; k >= 0; k--) {
        if (icons[k].parentNode) icons[k].parentNode.removeChild(icons[k]);
      }
    }
    if (anchorParent) {
      var holder = document.createElement('span');
      holder.innerHTML = ICON;
      anchorParent.insertBefore(holder.firstChild, anchorNext);
    } else {
      b.insertAdjacentHTML('afterbegin', ICON);
    }
    // 文案：把最后一个文本节点换掉（不同语言下都保留行高与排版）
    var labelSpan = b.querySelector('span');
    if (labelSpan) { labelSpan.removeAttribute('data-tour'); }
    var label = labelSpan || b;
    if (label && label.childNodes.length) {
      for (var i = 0; i < label.childNodes.length; i++) {
        if (label.childNodes[i].nodeType === 3 && label.childNodes[i].nodeValue.trim()) {
          label.childNodes[i].nodeValue = 'hermes-purge';
        }
      }
    }
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openPanel();
    }, true);
    return b;
  }

  function inject() {
    var ul = navList();
    if (ul) {
      if (ul.querySelector('[' + MARK + ']')) return true;
      var lastLi = ul.lastElementChild;
      if (!lastLi) return false;
      var btn = lastLi.querySelector('button, a');
      if (!btn) return false;
      var li = lastLi.cloneNode(true);           // 克隆整个 <li>，保持列表结构
      var oldBtn = li.querySelector('button, a');
      var newBtn = buildButton(btn);
      if (oldBtn && oldBtn.parentNode) oldBtn.parentNode.replaceChild(newBtn, oldBtn);
      else li.appendChild(newBtn);
      ul.appendChild(li);
      try { console.info('[hermes-purge] 侧边栏入口已注入（ul>li）'); } catch (e) {}
      return true;
    }
    return false;
  }

  // 失败诊断：把候选容器打出来，方便一次修好判定条件
  function diagnose() {
    var rows = [];
    var lists = document.querySelectorAll('ul');
    for (var i = 0; i < lists.length && rows.length < 8; i++) {
      var ul = lists[i];
      var n = ul.querySelectorAll(':scope > li > button, :scope > li > a, :scope > button, :scope > a').length;
      if (n >= 2) rows.push({ tag: 'ul', cls: String(ul.className).slice(0, 80), items: n });
    }
    try { console.info('[hermes-purge] 侧边栏候选：', JSON.stringify(rows)); } catch (e) {}
  }

  var CSS = [
    '#purge-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px}',
    '#purge-box{width:min(1080px,100%);height:min(84vh,900px);background:#0b1020;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.12)}',
    '#purge-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;color:#e2e8f0;font:13px -apple-system,system-ui;border-bottom:1px solid rgba(255,255,255,.1)}',
    '#purge-bar b{font-weight:600}',
    '#purge-bar span{color:#94a3b8;font-size:12px;margin-left:auto}',
    '#purge-close{margin-left:12px;cursor:pointer;border:1px solid rgba(255,255,255,.2);background:transparent;color:#e2e8f0;border-radius:8px;padding:2px 8px;font-size:12px}',
    '#purge-acts{display:flex;gap:6px;margin-left:12px}',
    '.purge-act{cursor:pointer;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#e2e8f0;border-radius:8px;padding:3px 10px;font:12px -apple-system,system-ui}',
    '.purge-act:hover{background:rgba(255,255,255,.14)}',
    '.purge-act:disabled{opacity:.5;cursor:default}',
    '#purge-out{margin:0;max-height:34%;overflow:auto;padding:10px 14px;font:12px ui-monospace,Menlo,monospace;white-space:pre-wrap;background:rgba(255,255,255,.04);color:#86efac}',
    '#purge-frame{flex:1;width:100%;border:0;background:#0b1020}'
  ].join('');
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  function api(path, opts) {
    return fetch('http://127.0.0.1:' + DATA.control.port + path, Object.assign({
      headers: { 'x-purge-token': DATA.control.token }
    }, opts || {}));
  }

  function wireActions(mask, frame) {
    var out = mask.querySelector('#purge-out');
    function show(text, bad) {
      out.hidden = false;
      out.textContent = text;
      out.style.color = bad ? '#fca5a5' : '#86efac';
    }
    function refreshFrame() {
      return api('/api/report').then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (html) { frame.srcdoc = html; });
    }
    Array.prototype.forEach.call(mask.querySelectorAll('.purge-act'), function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        var label = btn.textContent;
        btn.disabled = true;
        show('执行 ' + label + '…', false);
        api('/api/action', {
          method: 'POST',
          headers: { 'x-purge-token': DATA.control.token, 'content-type': 'application/json' },
          body: JSON.stringify({ action: act })
        }).then(function (r) {
          if (r.status === 401) throw new Error('token 不匹配：重启 purge serve');
          return r.json();
        }).then(function (j) {
          show((j.ok ? '✔ ' : '✖ ') + label + ' 完成' + NL + NL + (j.output || '').slice(-1500), !j.ok);
          return refreshFrame().catch(function () {});
        }).catch(function (e) {
          show('控制服务没响应：' + e.message + NL + NL + '先启动服务：purge serve', true);
        }).then(function () { btn.disabled = false; });
      });
    });
  }

  function openPanel() {
    if (document.getElementById('purge-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'purge-mask';
    var btns = [
      ['apply', '启用'], ['revert', '停用'], ['verify', '体检'], ['report', '刷新']
    ].map(function (b) {
      return '<button class="purge-act" data-act="' + b[0] + '">' + b[1] + '</button>';
    }).join('');
    mask.innerHTML = '<div id="purge-box">' +
      '<div id="purge-bar"><b>hermes-purge</b>' +
      '<span>' + (DATA.version ? 'v' + DATA.version + ' · ' : '') + (DATA.generatedAt || '') + '</span>' +
      '<div id="purge-acts">' + btns + '</div>' +
      '<button id="purge-close">关闭</button></div>' +
      '<pre id="purge-out" hidden></pre>' +
      '<iframe id="purge-frame"></iframe></div>';
    document.body.appendChild(mask);
    var frame = mask.querySelector('#purge-frame');
    frame.srcdoc = DATA.report;
    wireActions(mask, frame);
    mask.querySelector('#purge-close').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { var m = document.getElementById('purge-mask'); if (m) m.remove(); document.removeEventListener('keydown', esc); }
    });
  }

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (inject()) {
      clearInterval(timer);
      try { console.info('[hermes-purge] 侧边栏入口已注入'); } catch (e) {}
      return;
    }
    if (tries === 12) { try { console.info('[hermes-purge] 还在找侧边栏…'); } catch (e) {} }
    if (tries > 120) { clearInterval(timer); diagnose(); }
  }, 250);

  // 只在「被 React 重渲染冲掉」时补回来：节流到 1.5s 一次，且只查节点不读布局
  var lastCheck = 0;
  var mo = new MutationObserver(function () {
    var now = Date.now();
    if (now - lastCheck < 1500) return;
    lastCheck = now;
    if (!document.querySelector('[' + MARK + ']')) inject();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
`;
}

function install(distDir, opts) {
  const idx = path.join(distDir, 'index.html');
  const bak = idx + BAK_SUFFIX;
  const panel = path.join(distDir, PANEL_FILE);
  const o = opts || {};

  let html = fs.readFileSync(idx, 'utf8');
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, html, 'utf8');
  else html = fs.readFileSync(bak, 'utf8'); // 以原始文件为基线，保证幂等

  const src = panelSource(o.report || '', {
    version: o.version, generatedAt: o.generatedAt,
    controlPort: o.controlPort, controlToken: o.controlToken,
  });
  // 语法自检：宁可这里报错，也别把坏脚本写进宿主 UI
  new (require('vm').Script)(src, { filename: PANEL_FILE });
  fs.writeFileSync(panel, src, 'utf8');

  const fp = require('crypto').createHash('sha256').update(src).digest('hex').slice(0, 10);
  const tag = scriptTag(fp);
  // 幂等：先摘掉任意旧的 purge-panel 标签（含带指纹的），再插新的
  html = html.replace(/[ \t]*<script defer src="\.\/purge-panel\.js[^"]*"><\/script>\r?\n?/g, '');
  if (html.includes('</body>')) html = html.replace('</body>', '    ' + tag + '\n  </body>');
  else html += '\n' + tag + '\n';
  fs.writeFileSync(idx, html, 'utf8');
  return { distDir, index: idx, panel, patched: true };
}

function sync(distDir, opts) {
  const panel = path.join(distDir, PANEL_FILE);
  if (!fs.existsSync(panel)) return { ok: false, reason: 'not-installed' };
  const o = opts || {};
  fs.writeFileSync(panel, panelSource(o.report || '', { version: o.version, generatedAt: o.generatedAt }), 'utf8');
  return { ok: true, panel };
}

function uninstall(distDir) {
  const idx = path.join(distDir, 'index.html');
  const bak = idx + BAK_SUFFIX;
  const panel = path.join(distDir, PANEL_FILE);
  const removed = [];
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, idx);
    fs.unlinkSync(bak);
    removed.push('index.html（已还原）');
  } else if (fs.existsSync(idx)) {
    const html = fs.readFileSync(idx, 'utf8');
    if (html.includes('purge-panel.js')) {
      fs.writeFileSync(idx, html.replace(/[ \t]*<script defer src="\.\/purge-panel\.js"><\/script>\r?\n?/g, ''), 'utf8');
      removed.push('index.html（已摘掉脚本）');
    }
  }
  if (fs.existsSync(panel)) { fs.unlinkSync(panel); removed.push(PANEL_FILE); }
  return { removed };
}

function status(distDir) {
  const idx = path.join(distDir, 'index.html');
  const panel = path.join(distDir, PANEL_FILE);
  return {
    distDir,
    installed: fs.existsSync(panel) && fs.existsSync(idx) && fs.readFileSync(idx, 'utf8').includes('purge-panel.js'),
    hasBackup: fs.existsSync(idx + BAK_SUFFIX),
  };
}

module.exports = { findDists, install, sync, uninstall, status, panelSource, PANEL_FILE, scriptTag };
