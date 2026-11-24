'use strict';
/**
 * lib/anchors/hermes-0.21.0-addendum.js —— 0.21.0 上「同一件事、不同落点」的补充锚点
 *
 * 背景：3.3.0 起补丁面扩到 41 条（宿主防护层）。其中 C25/C26/C27 在 0.21.0 上
 * 要么没有对应文件、要么函数名还没改 —— 直接报 drifted 会让人以为坏了。
 * 这里给 0.21.0 补上等价落点；找不到的（C26/C27 的文件确实不存在）保持 unusable，
 * 但由 caps 侧标注成「该版本没有此机制」，而不是「漂移」。
 *
 * 只在 mac 泳道改这个文件。
 */

const label = '0.21.0';

module.exports = { label, map: {
  // C25 fs.credential_write_allow
  // 0.21.0 没有 deny_path_under()；同一份「凭证文件禁止写入」清单由
  // build_write_denied_paths(home) 构造，把它的返回值清空即可达到同样效果。
  C25: [{
    file: 'agent/file_safety.py',
    kind: 'insertAfter',
    anchor: 'def build_write_denied_paths(home: str) -> set[str]:',
    // ret 里不要带 MARK —— applyText 的 insertAfter 会自己补 `  # [hermes-purge]`
    ret: 'return set()  # C25 凭证写入放行（0.21.0 落点）',
    sentinel: 'return set()  # C25 凭证写入放行',
  }],
} };
