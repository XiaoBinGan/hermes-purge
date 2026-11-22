// 用宿主仓库里的 jsdom 真实跑一遍注入脚本，验证 ul>li 判定
// jsdom 借用宿主仓库里的（本仓零依赖）。找不到就跳过：这只验注入逻辑，不是必跑项。
let JSDOM = null;
for (const p of [
  '/Users/supre/.hermes/hermes-agent/node_modules/jsdom',
  process.env.HERMES_REPO ? require('path').join(process.env.HERMES_REPO, 'node_modules/jsdom') : '',
].filter(Boolean)) {
  try { JSDOM = require(p).JSDOM; break; } catch (e) { /* 继续找 */ }
}
if (!JSDOM) { console.log('跳过 DOM 注入用例（没找到 jsdom）'); process.exit(0); }
const desktop = require('../lib/v2/desktop.js');

const html = `<!doctype html><html><body>
  <aside data-tour="sessions-sidebar"><div>
    <ul class="session-list">
      <li><button><span>会话 1</span></button></li><li><button><span>会话 2</span></button></li>
      <li><button><span>会话 3</span></button></li><li><button><span>会话 4</span></button></li>
    </ul>
    <ul class="gap-px">
      <li><button class="h-7 w-full" aria-label="新建"><svg></svg><span>新建会话</span></button></li>
      <li><button class="h-7 w-full" aria-label="技能"><svg></svg><span>技能</span></button></li>
      <li><button class="h-7 w-full" aria-label="产物"><svg></svg><span>产物</span></button></li>
      <li><button class="h-7 w-full" aria-label="定时任务"><svg class="watch"></svg><span>定时任务</span><svg class="chevron"></svg></button></li>
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

setTimeout(() => {
  const btn = window.document.querySelector('[data-purge-nav]');
  const fail = (m) => { console.log('✖ ' + m); process.exit(1); };
  const lis = window.document.querySelectorAll('ul.gap-px > li');
  if (!btn) fail('没有注入入口');
  if (lis.length !== 5) fail('导航列表项数 ' + lis.length + '（应为 5，说明注错了列表）');
  if (!lis[lis.length - 1].contains(btn)) fail('入口不在最后一项（没有排在「定时任务」后面）');
  if (!/hermes-purge/.test(btn.textContent)) fail('文案没换：' + btn.textContent);
  // 克隆来的行有两个 svg（手表 + 小箭头），必须全清掉只留飞镖
  const svgs = btn.querySelectorAll('svg');
  if (svgs.length !== 1) fail('图标数量 ' + svgs.length + '（应只剩 1 个飞镖，不能残留手表/箭头）');
  if (/watch|chevron/.test(btn.innerHTML)) fail('残留了克隆来的图标 class：' + btn.innerHTML.slice(0, 160));
  if (btn) {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const mask = window.document.getElementById('purge-mask');
    const frame = window.document.getElementById('purge-frame');
    if (!mask) fail('点击没弹层');
    if (!((frame && frame.getAttribute('srcdoc') || '').includes('REPORT_OK'))) fail('iframe 里没有报告');
  }
  console.log('DOM 注入用例：全部通过');
  process.exit(0);
}, 600);
