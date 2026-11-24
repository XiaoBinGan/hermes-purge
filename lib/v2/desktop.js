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
const os = require('os');
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

  // 安装版桌面端（Electron 装到 Programs / Applications，dist 不在代码根下）：
  // 真实反馈「apply 全绿但菜单没出来」就是这种 —— 代码根是 pm 的 hermes-agent，
  // 桌面端却是单独装的 Electron 应用，findDists 原来只看 <target>/apps/desktop。
  // 只认名字里带 hermes 的目录：别的 Electron 应用也有 resources/app.asar.unpacked/dist，
  // 往里写面板等于污染别人的安装。
  const bases = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'hermes'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    '/Applications',
    path.join(os.homedir(), 'Applications'),
    path.join(os.homedir(), '.local', 'share'),
  ].filter(Boolean);
  for (const base of bases) {
    let names = [];
    try {
      names = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /hermes/i.test(e.name)).map((e) => e.name);
    } catch (e) { names = []; }
    for (const n of names) {
      const app = path.join(base, n);
      push(path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'dist')); // mac 安装版
      push(path.join(app, 'resources', 'app.asar.unpacked', 'dist'));            // win/linux 安装版
      push(path.join(app, 'resources', 'app', 'dist'));
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
  // 找导航列表：优先「有 gap-px 或有 sidebar-nav-* 标记」且项数不多，其次任意
  // 「≥3 个 li>button」的 ul。全部不读布局（读布局会在流式输出时卡死 renderer）。
  // 注意：data-tour="sidebar-nav-*" 在真实 DOM 里可能挂在 <span> 上，不在 <button> 上。
  function navItems(ul) {
    return ul.querySelectorAll(':scope > li > button, :scope > li > a, :scope > button, :scope > a').length;
  }

  function navList() {
    var lists = document.querySelectorAll('ul');
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < lists.length; i++) {
      var ul = lists[i];
      var n = navItems(ul);
      if (n < 3) continue;
      var score = 0;
      try {
        if (/(^|\s)gap-px(\s|$)/.test(String(ul.className || ''))) score += 3;
        if (ul.querySelector('[data-tour^="sidebar-nav-"]')) score += 3;
        // 真实 DOM 里导航行是 <li data-sidebar="menu-item">，会话行不是
        if (ul.querySelector('[data-sidebar="menu-item"]')) score += 3;
        if (n <= 12) score += 1; else score -= 2;
        if (ul.closest && ul.closest('aside, nav, [data-sidebar]')) score += 1;
      } catch (e) { /* 忽略 */ }
      if (score > bestScore) { best = ul; bestScore = score; }
    }
    return best;
  }

  function buildButton(proto) {
    var b = proto.cloneNode(true);
    // 剥掉过渡/动画类：SidebarMenuButton 自带 transition-colors duration-100，
    // 每次被 React 冲掉再插回来都会播一次淡入 —— 这就是用户看到的「闪」。
    // 注意：这里别写带反斜杠的正则字面量 —— 模板字符串会把反斜杠吃掉。
    var dropRe = new RegExp('^(transition|duration-|ease-|animate-|hover:transition)');
    try {
      Array.prototype.slice.call(b.classList).forEach(function (c) {
        if (dropRe.test(c)) b.classList.remove(c);
      });
    } catch (e) { /* classList 不可用时忽略 */ }
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
      li.setAttribute('data-purge-row', '1');
      madeRow = li;
      ul.appendChild(li);
      try { console.info('[hermes-purge] 侧边栏入口已注入（ul>li）'); } catch (e) {}
      return true;
    }
    return false;
  }

  // 失败诊断：一次把页面结构说清楚，免得来回猜
  function diagnose() {
    try {
      var info = {
        uls: document.querySelectorAll('ul').length,
        lis: document.querySelectorAll('li').length,
        buttons: document.querySelectorAll('button').length,
        aside: document.querySelectorAll('aside, [data-sidebar], nav').length,
        gapPx: document.querySelectorAll('ul.gap-px').length,
        navTour: document.querySelectorAll('[data-tour^="sidebar-nav-"]').length,
      };
      var cands = [];
      var lists = document.querySelectorAll('ul');
      for (var i = 0; i < lists.length && cands.length < 6; i++) {
        var ul = lists[i];
        var n = navItems(ul);
        if (n < 2) continue;
        cands.push({
          cls: String(ul.className || '').slice(0, 60),
          li: n,
          gap: /(^|\s)gap-px(\s|$)/.test(String(ul.className || '')),
          tour: !!ul.querySelector('[data-tour^="sidebar-nav-"]'),
          inAside: !!(ul.closest && ul.closest('aside, nav, [data-sidebar]')),
        });
      }
      console.info('[hermes-purge] 结构: ' + JSON.stringify(info) + ' 候选: ' + JSON.stringify(cands));
    } catch (e) { console.info('[hermes-purge] diagnose 失败: ' + e.message); }
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
    '#purge-frame{flex:1;width:100%;border:0;background:#0b1020}',
    '#purge-eula-mask{position:fixed;inset:0;z-index:2147483600;background:rgba(3,7,18,.72);display:flex;align-items:center;justify-content:center;padding:24px}',
    '#purge-eula-box{width:min(580px,100%);background:#0b1020;color:#e2e8f0;border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.55);font:14px/1.65 -apple-system,system-ui;overflow:hidden}',
    '#purge-eula-h{padding:14px 18px;font-weight:600;font-size:15px;border-bottom:1px solid rgba(255,255,255,.1)}',
    '#purge-eula-b{padding:14px 18px;max-height:52vh;overflow:auto}',
    '#purge-eula-b p{margin:0 0 10px}',
    '#purge-eula-b ul{margin:0;padding-left:20px}',
    '#purge-eula-b li{margin:6px 0}',
    '#purge-eula-b code{background:rgba(255,255,255,.1);border-radius:4px;padding:1px 5px;font:12px ui-monospace,Menlo,monospace}',
    '#purge-eula-f{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:12px 18px;border-top:1px solid rgba(255,255,255,.1)}',
    '#purge-eula-more{color:#93c5fd;text-decoration:none;font-size:13px}',
    '#purge-eula-ok{cursor:pointer;border:0;border-radius:9px;padding:8px 16px;font:13px -apple-system,system-ui;font-weight:600;background:#2563eb;color:#fff}',
    '#purge-eula-ok:hover{background:#1d4ed8}'
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

  /* 首次启动的免责声明：改宿主源码的工具，不该悄悄生效。
     只弹一次（localStorage 记版本号）；存储不可用时每次启动都弹，宁可烦也别假装没事。 */
  var EULA_KEY = 'hermes-purge.eula.v1';
  function showDisclaimer() {
    var accepted = false;
    try { accepted = localStorage.getItem(EULA_KEY) === '1'; } catch (e) { accepted = false; }
    if (accepted) return;
    if (document.getElementById('purge-eula-mask')) return;
    var m = document.createElement('div');
    m.id = 'purge-eula-mask';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.innerHTML = '<div id="purge-eula-box">' +
      '<div id="purge-eula-h">免责声明 · hermes-purge</div>' +
      '<div id="purge-eula-b">' +
        '<p>这个工具会<b>改动 Hermes 的源码与配置</b>（关审批/护栏、注入提示词）。改之前会备份，' +
        '<code>purge revert</code> 可逐字节还原。</p>' +
        '<ul>' +
          '<li>只在你<b>拥有或被授权使用</b>的机器上使用，后果自负。</li>' +
          '<li>它会让宿主更容易执行危险操作，请自行判断风险。</li>' +
          '<li>Hermes 升级后需要重跑 <code>purge setup</code> / <code>purge desktop install</code>。</li>' +
          '<li>请遵守所在地法律与所在组织的使用规定。</li>' +
        '</ul>' +
      '</div>' +
      '<div id="purge-eula-f">' +
        '<a id="purge-eula-more" href="https://github.com/XiaoBinGan/hermes-purge#readme" target="_blank" rel="noreferrer">看说明</a>' +
        '<button id="purge-eula-ok">我已了解并继续</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(m);
    var ok = m.querySelector('#purge-eula-ok');
    ok.addEventListener('click', function () {
      try { localStorage.setItem(EULA_KEY, '1'); } catch (e) { /* 存储不可用就只能每次弹 */ }
      m.remove();
    });
    try { ok.focus(); } catch (e) {}
  }

  // 补齐策略：React 每次重渲染都可能把我们的 <li> 删掉，删掉到补回之间就是「闪」。
  // 所以：MutationObserver 回调里**同步**补（不等 rAF，赶在下一帧绘制前），
  // inject() 不读布局（纯选择器 + append），代价小；50ms 最小间隔防止流式输出时被刷爆。
  var busiest = 0;
  var madeRow = null;
  var chosenSig = null;   // 记住第一次注入的那个列表的「形状签名」

  function sig(ul) {
    try {
      return String(ul.className || '').trim() +
        (ul.querySelector('[data-sidebar="menu-item"]') ? '|M' : '') +
        (ul.querySelector('[data-tour^="sidebar-nav-"]') ? '|T' : '') +
        '|n' + navItems(ul);
    } catch (e) { return '?'; }
  }

  function ensure() {
    var ul = navList();
    if (!ul) return;
    var s2 = sig(ul);
    // 已经认过一种列表：换了一副样子（比如导航被隐藏、只剩会话列表）就先不注，等它回来
    if (chosenSig && s2 !== chosenSig) return;
    if (ul.querySelector('[' + MARK + ']') || ul.querySelector('[data-purge-row]')) return;   // 已经在正确列表里
    var elsewhere = document.querySelector('[data-purge-row]') || document.querySelector('[' + MARK + ']');
    if (elsewhere) {                                        // 被 React 挪到别处：挪回来，不重复注入
      ul.appendChild(elsewhere.nodeName === 'LI' ? elsewhere : (elsewhere.closest('li') || elsewhere));
      return;
    }
    var now = Date.now();
    if (now - busiest < 50) return;                          // 最小间隔，避免高频抖动
    busiest = now;
    try {
      if (inject()) {
        chosenSig = s2;
      }
      if (!ensure.logged) {
        ensure.logged = true;
        try { console.info('[hermes-purge] 侧边栏入口已注入'); } catch (e) {}
      }
    } catch (e) { /* 注入失败不影响宿主 */ }
  }

  // 首屏：连续若干帧尝试（React 挂载是异步的）
  var boot = 0;
  var bootTimer = setInterval(function () {
    ensure();
    if (document.querySelector('[' + MARK + ']')) { clearInterval(bootTimer); return; }
    if (++boot > 80) { clearInterval(bootTimer); diagnose(); }
  }, 50);

  // 免责声明：等首屏渲染完再弹（不抢 React 的挂载），只弹一次
  var eulaTimer = setInterval(function () {
    if (!document.body) return;
    clearInterval(eulaTimer);
    setTimeout(showDisclaimer, 700);
  }, 150);

  // 之后：任何 DOM 变更都同步检查一次（含「侧边栏隐藏再显示」这种整体重挂）
  var mo = new MutationObserver(function () { ensure(); });
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
  fs.writeFileSync(panel, panelSource(o.report || '', {
    version: o.version, generatedAt: o.generatedAt,
    controlPort: o.controlPort, controlToken: o.controlToken,
  }), 'utf8');
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
  const base = {
    distDir,
    installed: fs.existsSync(panel) && fs.existsSync(idx) && fs.readFileSync(idx, 'utf8').includes('purge-panel.js'),
    hasBackup: fs.existsSync(idx + BAK_SUFFIX),
  };
  const snap = snapshotInfo(distDir);

  return Object.assign(base, snap);
}

/** 面板里那份快照是谁、什么时候生成的（用来判断过期） */
function snapshotInfo(distDir) {
  const panel = path.join(distDir, PANEL_FILE);
  if (!fs.existsSync(panel)) return { snapshotVersion: null, snapshotAt: null };
  let text = '';
  try { text = fs.readFileSync(panel, 'utf8'); } catch (e) { return { snapshotVersion: null, snapshotAt: null }; }
  if (text.length > 2e6) text = text.slice(0, 200000) + text.slice(-200000);   // 保险：别把超大文件整个留在内存
  const v = text.match(/"version":"([^"]*)"/);
  const t = text.match(/"generatedAt":"([^"]*)"/);
  return { snapshotVersion: v ? v[1] : null, snapshotAt: t ? t[1] : null };
}

/** 快照是否落后于当前 CLI 版本 */
function isStale(distDir, currentVersion) {
  const info = snapshotInfo(distDir);
  if (!info.snapshotVersion) return false;
  return String(info.snapshotVersion) !== String(currentVersion);
}

module.exports = { findDists, install, sync, uninstall, status, snapshotInfo, isStale, panelSource, PANEL_FILE, scriptTag };
