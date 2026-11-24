'use strict';
/**
 * test/agent-restart.js —— 服务没在跑时，status 要给出「怎么拉起来」
 *
 * 背景（真机验证）：有些机器（锁屏 / 无图形会话 / 受限的笔记本）不认 launchd 的
 * RunAtLoad 与 KeepAlive —— 杀掉进程后不会自动重启，plist 加载着但 pid 是 `-`。
 * 所以必须有 `purge agent restart`（kickstart），并且 status 要说人话。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cli = fs.readFileSync(path.join(__dirname, '..', 'bin', 'purge.js'), 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

console.log('\nagent restart');

t('有 restart 子命令，且走 kickstart -k', () => {
  assert.ok(/sub === 'restart' \|\| sub === 'start'/.test(cli), '没有 restart 分支');
  // 源码里是 run('launchctl', ['kickstart', '-k', …])，直接断言子串即可
  const m = cli.match(/kickstart[^\n]*/g) || [];
  assert.ok(m.some((x) => x.includes("'-k'")), '没用 kickstart -k：' + JSON.stringify(m));
});

t('status 在「已加载但没跑」时给出可操作的提示', () => {
  assert.ok(/不认 RunAtLoad\/KeepAlive/.test(cli), 'status 没解释原因');
  assert.ok(/purge agent restart/.test(cli), 'status 没给命令');
});

t('help 里列出 restart', () => {
  assert.ok(/purge agent \[install\|status\|restart\|uninstall\]/.test(cli), 'help 没更新');
});

console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
