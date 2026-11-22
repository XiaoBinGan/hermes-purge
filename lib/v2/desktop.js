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
const SCRIPT_TAG = '<script defer src="./purge-panel.js"></script>';

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
  });
  return `/* hermes-purge 桌面面板（由 purge desktop install 生成，别手改） */
(function () {
  if (window.__HERMES_PURGE_PANEL__) return;
  window.__HERMES_PURGE_PANEL__ = true;
  var DATA = ${payload};
  var MARK = 'data-purge-nav';
  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 8.5l3 3 8-8"/><path d="M2.5 12.5h11"/></svg>';

  function navContainer() {
    // 侧边栏 = 左边缘、窄、竖排、至少 3 个可点项的那个容器
    var best = null;
    var nodes = document.querySelectorAll('nav, aside, div');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      if (r.width < 40 || r.width > 140 || r.left > 160 || r.height < 120) continue;
      var kids = Array.prototype.filter.call(el.children, function (c) {
        var cs = window.getComputedStyle(c);
        return cs.display !== 'none' && c.getBoundingClientRect().height > 20;
      });
      if (kids.length < 3) continue;
      if (!best || kids.length > best.kids) best = { el: el, kids: kids.length };
    }
    return best ? best.el : null;
  }

  function buildButton(proto) {
    var b = proto.cloneNode(true);
    b.setAttribute(MARK, '1');
    b.setAttribute('role', 'button');
    b.setAttribute('title', 'hermes-purge 状态');
    b.setAttribute('aria-label', 'hermes-purge 状态');
    b.removeAttribute('href');
    // 换掉图标：保留第一个 svg 的位置与 class，替换成对勾
    var svg = b.querySelector('svg');
    if (svg && svg.parentNode) {
      var wrap = document.createElement('span');
      wrap.innerHTML = ICON;
      svg.parentNode.replaceChild(wrap.firstChild, svg);
    } else {
      b.insertAdjacentHTML('afterbegin', ICON);
    }
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openPanel();
    }, true);
    return b;
  }

  function inject() {
    var host = navContainer();
    if (!host) return false;
    var existing = host.querySelector('[' + MARK + ']');
    if (existing) return true;
    var proto = host.lastElementChild;
    if (!proto) return false;
    host.appendChild(buildButton(proto));
    try { console.info('[hermes-purge] 侧边栏入口已注入'); } catch (e) {}
    return true;
  }

  var CSS = [
    '#purge-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px}',
    '#purge-box{width:min(1080px,100%);height:min(84vh,900px);background:#0b1020;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(255,255,255,.12)}',
    '#purge-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;color:#e2e8f0;font:13px -apple-system,system-ui;border-bottom:1px solid rgba(255,255,255,.1)}',
    '#purge-bar b{font-weight:600}',
    '#purge-bar span{color:#94a3b8;font-size:12px;margin-left:auto}',
    '#purge-close{margin-left:12px;cursor:pointer;border:1px solid rgba(255,255,255,.2);background:transparent;color:#e2e8f0;border-radius:8px;padding:2px 8px;font-size:12px}',
    '#purge-frame{flex:1;width:100%;border:0;background:#0b1020}'
  ].join('');
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  function openPanel() {
    if (document.getElementById('purge-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'purge-mask';
    mask.innerHTML = '<div id="purge-box"><div id="purge-bar"><b>hermes-purge</b>' +
      '<span>' + (DATA.version ? 'v' + DATA.version + ' · ' : '') + (DATA.generatedAt || '') + '</span>' +
      '<button id="purge-close">关闭</button></div><iframe id="purge-frame"></iframe></div>';
    document.body.appendChild(mask);
    var frame = mask.querySelector('#purge-frame');
    frame.srcdoc = DATA.report;
    mask.querySelector('#purge-close').addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { var m = document.getElementById('purge-mask'); if (m) m.remove(); document.removeEventListener('keydown', esc); }
    });
  }

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (inject()) { clearInterval(timer); return; }
    if (tries === 12) { try { console.info('[hermes-purge] 还在找侧边栏…'); } catch (e) {} }
    if (tries > 120) clearInterval(timer);
  }, 250);

  var mo = new MutationObserver(function () {
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

  const src = panelSource(o.report || '', { version: o.version, generatedAt: o.generatedAt });
  // 语法自检：宁可这里报错，也别把坏脚本写进宿主 UI
  new (require('vm').Script)(src, { filename: PANEL_FILE });
  fs.writeFileSync(panel, src, 'utf8');

  if (!html.includes('purge-panel.js')) {
    if (html.includes('</body>')) html = html.replace('</body>', '    ' + SCRIPT_TAG + '\n  </body>');
    else html += '\n' + SCRIPT_TAG + '\n';
    fs.writeFileSync(idx, html, 'utf8');
  }
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

module.exports = { findDists, install, sync, uninstall, status, panelSource, PANEL_FILE, SCRIPT_TAG };
