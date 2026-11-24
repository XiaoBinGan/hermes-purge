'use strict';
/**
 * test/agent.js —— launchd plist 生成（macOS 开机自启）
 *
 * 只测纯函数：真跑 launchctl 会污染开发机，放到人工验收里（本轮已人工验过：
 * uninstall → install → 自动 kickstart → /api/health 200）。
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const agent = require('../lib/v2/agent');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

console.log('\nlaunchd plist（purge agent）');

const xml = agent.plist({
  node: '/usr/local/bin/node',
  cli: '/Users/x/.hermes-purge/app/bin/purge.js',
  target: '/Users/x/.hermes/hermes-agent',
  port: 9123,
  home: '/Users/x',
});

t('包含必需键：Label / ProgramArguments / RunAtLoad / KeepAlive / 日志路径', () => {
  for (const k of ['Label', 'ProgramArguments', 'RunAtLoad', 'KeepAlive', 'StandardOutPath', 'StandardErrorPath']) {
    assert.ok(xml.includes('<key>' + k + '</key>'), '缺 ' + k);
  }
  assert.ok(xml.includes('<string>' + agent.LABEL + '</string>'));
  assert.ok(/<true\/>/.test(xml), 'RunAtLoad/KeepAlive 应该是 <true/>');
});

t('ProgramArguments 顺序正确：node → cli → serve → --target → --port', () => {
  const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
    .filter((s) => s === '/usr/local/bin/node' || s.endsWith('purge.js') || s === 'serve' || s.startsWith('--'));
  assert.deepStrictEqual(args, [
    '/usr/local/bin/node',
    '/Users/x/.hermes-purge/app/bin/purge.js',
    'serve',
    '--target=/Users/x/.hermes/hermes-agent',
    '--port=9123',
  ]);
});

t('日志路径落在 ~/Library/Logs，plist 落在 ~/Library/LaunchAgents', () => {
  assert.strictEqual(agent.logPath('/Users/x'), path.join('/Users/x', 'Library', 'Logs', 'hermes-purge-serve.log'));
  assert.strictEqual(agent.plistPath('/Users/x'), path.join('/Users/x', 'Library', 'LaunchAgents', agent.LABEL + '.plist'));
  assert.ok(xml.includes(agent.logPath('/Users/x').replace(/&/g, '&amp;')));
});

t('特殊字符被转义（路径里带 & < > 也不会写坏 XML）', () => {
  const odd = agent.plist({ node: '/n', cli: '/a&b/bin/<purge>.js', target: '/t', port: 9123, home: '/Users/x' });
  assert.ok(odd.includes('/a&amp;b/bin/&lt;purge&gt;.js'), '没有转义');
  assert.ok(!/&(?![a-z]+;)/.test(odd.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, '')), '有裸 & 字符');
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
