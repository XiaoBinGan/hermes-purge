'use strict';
/**
 * lib/v2/agent.js —— 把 `purge serve` 变成开机自启的后台服务（macOS launchd）
 *
 * 为什么需要：桌面面板上的「启用/停用/体检/刷新」按钮要调本地控制服务，
 * 服务没起按钮就是死的。手动 `purge serve` 一关终端就没了，所以给它一个 launchd 代理。
 *
 * 只做 macOS；Windows 侧对应的是计划任务，由 win 泳道自己实现（不要在这里加 win32 分支）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LABEL = 'com.xiaobingan.hermes-purge.serve';

function plistPath(home) {
  return path.join(home || os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
}

function logPath(home) {
  return path.join(home || os.homedir(), 'Library', 'Logs', 'hermes-purge-serve.log');
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 生成 plist 内容。纯函数，便于测试（不依赖 launchd）。
 * @param {{ node:string, cli:string, target:string, port:number, home?:string }} o
 */
function plist(o) {
  const args = [
    o.node, o.cli, 'serve',
    '--target=' + o.target,
    '--port=' + String(o.port),
  ];
  const argXml = args.map((a) => '    <string>' + xml(a) + '</string>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath(o.home))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath(o.home))}</string>
</dict>
</plist>
`;
}

module.exports = { LABEL, plist, plistPath, logPath };
