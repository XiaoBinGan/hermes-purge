'use strict';
/**
 * lib/anchors/hermes-win.js —— Windows 泳道自己的锚点（lane/win 维护）
 *
 * 规则：这个文件只由 Windows 那条线修改；macOS 那条线不碰它。
 * 反过来，lib/anchors/hermes-0.21.0.js 只由 macOS 那条线修改。
 * 两侧改的是不同文件，所以永远不会冲突。
 *
 * 加一组变体的写法（把 label 换成宿主真实版本号）：
 *
 *   const label = '0.21.1';
 *   module.exports = { label, map: {
 *     C13: [{ file: 'agent/xxx.py', kind: 'splice',
 *       find: `            api_messages = [{"role": "system", "content": effective_system}] + api_messages\n`,
 *       to: `            # [hermes-purge] C13 …\n            api_messages = [...]\n` }],
 *   } };
 *
 * 关键词：find 必须带真实缩进；to 保持同样缩进并保留 [hermes-purge] 标记。
 */

module.exports = { label: 'win-lane', map: {} };
