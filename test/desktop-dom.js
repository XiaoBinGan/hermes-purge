// 用宿主仓库里的 jsdom 真实跑一遍注入脚本，验证 ul>li 判定
// jsdom 借用宿主仓库里的（本仓零依赖）。找不到就跳过：这只验注入逻辑，不是必跑项。
const pathMod = require('path');
const os = require('os');
let JSDOM = null;
// 宿主仓库优先（借用它的依赖，本仓仍是零依赖）；找不到就用本仓 devDeps 里临时装的。
// 以前这里写死了 /Users/supre/... —— 只有那台 Mac 能跑，Windows 永远「跳过」。
const candidates = [
  process.env.HERMES_REPO ? pathMod.join(process.env.HERMES_REPO, 'node_modules/jsdom') : '',
  process.env.HERMES_HOME ? pathMod.join(process.env.HERMES_HOME, 'hermes-agent', 'node_modules', 'jsdom') : '',
  pathMod.join(os.homedir(), '.hermes', 'hermes-agent', 'node_modules', 'jsdom'),
  pathMod.join(__dirname, '..', 'node_modules', 'jsdom'),
].filter(Boolean);
for (const p of candidates) {
  try { JSDOM = require(p).JSDOM; break; } catch (e) { /* 继续找 */ }
}
if (!JSDOM) {
  try { JSDOM = require('jsdom').JSDOM; } catch (e) { /* 都没有 */ }
}
if (!JSDOM) { console.log('跳过 DOM 注入用例（没找到 jsdom）'); process.exit(0); }
const desktop = require('../lib/v2/desktop.js');

const html = `<!doctype html><html><body>
  <aside data-tour="sessions-sidebar"><div>
    <ul class="session-list">
      <li><button><span>会话 1</span></button></li><li><button><span>会话 2</span></button></li>
      <li><button><span>会话 3</span></button></li><li><button><span>会话 4</span></button></li>
      <li><button><span>会话 5</span></button></li><li><button><span>会话 6</span></button></li>
      <li><button><span>会话 7</span></button></li><li><button><span>会话 8</span></button></li>
      <li><button><span>会话 9</span></button></li><li><button><span>会话 10</span></button></li>
      <li><button><span>会话 11</span></button></li><li><button><span>会话 12</span></button></li>
    </ul>
    <ul class="gap-px">
      <li><button class="h-7 w-full" aria-label="新建"><svg></svg><span>新建会话</span></button></li>
      <li><button class="h-7 w-full" aria-label="技能"><svg></svg><span>技能</span></button></li>
      <li><button class="h-7 w-full" aria-label="产物"><svg></svg><span>产物</span></button></li>
      <li><button class="h-7 w-full" aria-label="定时任务" data-tour="sidebar-nav-cron" data-state="closed"><i aria-hidden="true" class="codicon codicon-watch size-4 shrink-0"></i><span data-tour="sidebar-nav-cron">定时任务</span><svg class="chevron"></svg></button></li>
    </ul>
  </div></aside></body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
// jsdom 没有布局：给元素一个假的 rect，模拟「靠左、有宽度」
window.Element.prototype.getBoundingClientRect = function () {
  return { left: 8, top: 0, right: 200, bottom: 24, width: 192, height: 24 };
};
const src = desktop.panelSource('<html><body>REPORT_OK</body></html>', { version: '2.9.0' });
try {
  window.eval(src);
} catch (e) { console.log('执行报错:', e.message); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(m) { console.log('✖ ' + m); process.exit(1); }

(async () => {
  await sleep(600);                       // 等注入脚本的首屏循环跑完
  const btn = window.document.querySelector('[data-purge-nav]');
  const lis = window.document.querySelectorAll('ul.gap-px > li');
  if (!btn) fail('没有注入入口');
  if (lis.length !== 5) fail('导航列表项数 ' + lis.length + '（应为 5，说明注错了列表）');
  if (!lis[lis.length - 1].contains(btn)) fail('入口不在最后一项（没有排在「定时任务」后面）');
  if (!/hermes-purge/.test(btn.textContent)) fail('文案没换：' + btn.textContent);
  // 克隆来的行有两个图标（codicon 手表 + svg 小箭头），必须全清掉只留飞镖
  const svgs = btn.querySelectorAll('svg');
  if (svgs.length !== 1) fail('图标数量 ' + svgs.length + '（应只剩 1 个飞镖，不能残留手表/箭头）');
  if (/watch|chevron|codicon/.test(btn.innerHTML)) fail('残留了克隆来的图标 class：' + btn.innerHTML.slice(0, 200));
  if (/sidebar-nav-cron/.test(btn.outerHTML)) fail('还带着 cron 的 data-tour 标记');
  if (/transition|duration-/.test(String(btn.className || ''))) fail('还带着过渡类（会闪）：' + btn.className);
  if (!String(btn.className).includes('h-7')) fail('clone 丢了原生尺寸类（h-7）：' + JSON.stringify(String(btn.className)));

  // 点击 → 弹层 + iframe 里有报告
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const mask = window.document.getElementById('purge-mask');
  const frame = window.document.getElementById('purge-frame');
  if (!mask) fail('点击没弹层');
  if (!((frame && frame.getAttribute('srcdoc') || '').includes('REPORT_OK'))) fail('iframe 里没有报告');
  mask.remove();
  console.log('✓ 注入 / 图标 / 文案 / 点击');

  // 隐藏再显示（= React 重挂载整段侧边栏）：入口要自己回来，且只有一个、不闪
  const ul = window.document.querySelector('ul.gap-px');
  const parent = ul.parentNode;
  const nextSibling = ul.nextSibling;
  ul.remove();
  await sleep(60);
  parent.insertBefore(ul, nextSibling);
  await sleep(200);
  const again = window.document.querySelectorAll('[data-purge-nav]');
  if (again.length !== 1) fail('重挂载后入口数量 ' + again.length + '（应为 1，多了就是重复注入）');
  const navUl = window.document.querySelector('ul.gap-px');
  if (!navUl.contains(again[0])) fail('入口没回到导航列表里（注到别处了）');
  if (!String(again[0].className).includes('h-7')) fail('重挂载后的入口丢了尺寸类');
  if (/transition|duration-/.test(String(again[0].className || ''))) fail('重挂载后带过渡类（会闪）');
  console.log('✓ 隐藏再显示后回到导航列表，且只有一个');

  console.log('DOM 注入用例：全部通过');
  process.exit(0);
})().catch((e) => { console.log('✖ 异常：' + e.message); process.exit(1); });
