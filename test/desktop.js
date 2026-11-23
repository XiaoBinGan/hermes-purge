'use strict';
/**
 * test/desktop.js —— 桌面端面板注入层自检
 *
 * 这层动的是打包好的 renderer（app.asar.unpacked/dist），所以测试必须证明：
 *   1. 只加一行 <script> + 两个文件；原始 index.html 有备份、能逐字节还原
 *   2. 重复 install 幂等（以备份为基线，不会叠加多行）
 *   3. 生成的面板脚本是合法 JS（语法自检在 install 里也有一道）
 *   4. uninstall 在「有备份 / 没备份但被改过」两种情况下都能还原干净
 *
 * DOM 注入本身跑不了（需要真实 Electron 渲染进程），这部分由人工验收：
 * 重启桌面端 → 侧边栏「定时任务」下面应出现 hermess-purge 入口。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const desktop = require('../lib/v2/desktop');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-desktop-'));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  \u2714 ' + name); }
  catch (e) { fail++; console.log('  \u2716 ' + name + '  → ' + e.message); }
}

function makeDist(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const html = '<!doctype html><html><head><title>Hermes</title></head><body><div id="root"></div></body></html>';
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc.js'), '// app');
  return { dir, html };
}

const a = makeDist('dist-a');

console.log('\n注入 / 还原');

t('install 只加一个 script 标签，并留下原始备份', () => {
  desktop.install(a.dir, { report: '<html><body>REPORT</body></html>', version: '9.9.9', generatedAt: '2026-01-01 00:00' });
  const html = fs.readFileSync(path.join(a.dir, 'index.html'), 'utf8');
  assert.strictEqual((html.match(/purge-panel\.js/g) || []).length, 1, '标签数量不对');
  assert.ok(html.includes('</body>'));
  assert.ok(fs.existsSync(path.join(a.dir, 'index.html.purge-bak')));
  assert.strictEqual(fs.readFileSync(path.join(a.dir, 'index.html.purge-bak'), 'utf8'), a.html, '备份不是原件');
  assert.ok(fs.existsSync(path.join(a.dir, 'purge-panel.js')));
});

t('面板脚本是合法 JS，且带上报告快照与注入标记', () => {
  const src = fs.readFileSync(path.join(a.dir, 'purge-panel.js'), 'utf8');
  new vm.Script(src, { filename: 'purge-panel.js' });   // 只编译不执行：验语法，不依赖 DOM
  assert.ok(src.includes('data-purge-nav'), '没有注入标记');
  assert.ok(src.includes('REPORT'), '没有内联报告');
  assert.ok(src.includes('srcdoc'), '没有用 srcdoc 渲染');
});

t('重复 install 幂等（不会叠加第二个标签）', () => {
  desktop.install(a.dir, { report: 'X', version: '9.9.9', generatedAt: '' });
  const html = fs.readFileSync(path.join(a.dir, 'index.html'), 'utf8');
  assert.strictEqual((html.match(/purge-panel\.js/g) || []).length, 1);
});

t('sync 只刷新脚本，不动 index.html', () => {
  const before = fs.readFileSync(path.join(a.dir, 'index.html'), 'utf8');
  const r = desktop.sync(a.dir, { report: 'NEW-REPORT', version: '9.9.9' });
  assert.ok(r.ok);
  assert.ok(fs.readFileSync(path.join(a.dir, 'purge-panel.js'), 'utf8').includes('NEW-REPORT'));
  assert.strictEqual(fs.readFileSync(path.join(a.dir, 'index.html'), 'utf8'), before);
});

t('uninstall 把 index.html 还原成原件、删掉面板脚本', () => {
  const r = desktop.uninstall(a.dir);
  assert.ok(r.removed.length >= 2, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(a.dir, 'index.html'), 'utf8'), a.html, '没还原成原件');
  assert.ok(!fs.existsSync(path.join(a.dir, 'purge-panel.js')));
  assert.ok(!fs.existsSync(path.join(a.dir, 'index.html.purge-bak')));
});

t('没有备份但 index.html 被改过时，uninstall 也能摘干净', () => {
  const b = makeDist('dist-b');
  fs.writeFileSync(path.join(b.dir, 'index.html'),
    b.html.replace('</body>', '<script defer src="./purge-panel.js"></script>\n</body>'));
  fs.writeFileSync(path.join(b.dir, 'purge-panel.js'), '// x');
  desktop.uninstall(b.dir);
  const html = fs.readFileSync(path.join(b.dir, 'index.html'), 'utf8');
  assert.ok(!html.includes('purge-panel.js'), '标签没摘掉');
  assert.ok(html.includes('</body>'), 'html 结构被破坏');
});

t('控制服务的 port/token 会被写进面板脚本（漏了就会 401）', () => {
  const dir = makeDist('dist-token').dir;
  desktop.install(dir, { report: 'X', version: '1', controlPort: 9123, controlToken: 'deadbeef' });
  const src = fs.readFileSync(path.join(dir, 'purge-panel.js'), 'utf8');
  assert.ok(src.includes('"token":"deadbeef"'), 'token 没写进去：' + (src.match(/"control":\{[^}]*\}/) || [''])[0]);
  assert.ok(src.includes('"port":9123'));
  desktop.uninstall(dir);
});

t('script 标签带内容指纹（避免 Electron 跑旧缓存）', () => {
  const dir = makeDist('dist-cache').dir;
  desktop.install(dir, { report: 'A', version: '1' });
  const h1 = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').match(/purge-panel\.js\?v=([0-9a-f]+)/);
  assert.ok(h1, '没有指纹：' + fs.readFileSync(path.join(dir, 'index.html'), 'utf8').slice(-200));
  desktop.install(dir, { report: 'B', version: '1' });
  const html2 = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const h2 = html2.match(/purge-panel\.js\?v=([0-9a-f]+)/);
  assert.ok(h2 && h2[1] !== h1[1], '内容变了指纹没变');
  assert.strictEqual((html2.match(/purge-panel\.js/g) || []).length, 1, '标签重复了');
  desktop.uninstall(dir);
});

t('注入脚本不读布局（getBoundingClientRect 会把 Electron renderer 卡死）', () => {
  const src = desktop.panelSource('<html></html>', { version: 'x' });
  const hits = src.split('\n').filter((l) => l.includes('getBoundingClientRect') && !l.trim().startsWith('//'));
  assert.strictEqual(hits.length, 0, '代码里还有布局读取：' + hits.slice(0, 2).join(' / '));
});

t('status 能报出安装状态与备份', () => {
  assert.deepStrictEqual(desktop.status(a.dir), { distDir: a.dir, installed: false, hasBackup: false });
  desktop.install(a.dir, { report: 'x' });
  const st = desktop.status(a.dir);
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.hasBackup, true);
  desktop.uninstall(a.dir);
});

t('findDists 能在假宿主里找到 dist 与打包产物', () => {
  const host = path.join(TMP, 'host');
  fs.mkdirSync(path.join(host, 'apps', 'desktop', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(host, 'apps', 'desktop', 'dist', 'index.html'), '<html><body></body></html>');
  const packed = path.join(host, 'apps', 'desktop', 'release', 'mac-arm64', 'Hermes.app', 'Contents', 'Resources', 'app.asar.unpacked', 'dist');
  fs.mkdirSync(packed, { recursive: true });
  fs.writeFileSync(path.join(packed, 'index.html'), '<html><body></body></html>');
  const found = desktop.findDists(host);
  assert.strictEqual(found.length, 2, JSON.stringify(found));
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
