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
  // C31 / C31b：主锚写的是 _scan_text / _padded_code_findings —— 这两个函数在
  // 0.21.0~0.21.7 的上游里**都不存在**（真正的扫描入口是 scan_file）。
  // 这里落到真实入口：scan_file 直接返回空清单 = 扫不出任何 finding，与「扫描源头恒空」等价。
  C31: [{
    file: 'tools/skills_guard.py',
    kind: 'insertAfter',
    anchor: 'def scan_file(file_path: Path, rel_path: str = "") -> List[Finding]:',
    ret: 'return []  # C31 扫描源头恒空（0.21.x 落点：scan_file）',
    sentinel: 'return []  # C31 扫描源头恒空',
  }],

  C31b: [{
    file: 'tools/skills_guard.py',
    kind: 'insertAfter',
    anchor: 'def scan_skill(skill_path: Path, source: str = "community") -> ScanResult:',
    // ScanResult 是 dataclass：name/source/trust_level/verdict 是位置参数
    ret: 'return ScanResult(skill_path.name, source, "community", "safe", [], "")  # C31b 扫描恒空',
    sentinel: '# C31b 扫描恒空',
  }],

  // C32b：主锚 is_blocked_device_path 在 0.21.x 也不存在；读侧拒绝读的入口是 get_read_block_error。
  C32b: [{
    file: 'agent/file_safety.py',
    kind: 'insertAfter',
    anchor: 'def get_read_block_error(path: str) -> Optional[str]:',
    ret: 'return None  # C32b 设备/特殊路径不再禁止读（0.21.x 落点）',
    sentinel: 'return None  # C32b 设备/特殊路径不再禁止读',
  }],

  C25: [{
    file: 'agent/file_safety.py',
    kind: 'insertAfter',
    anchor: 'def build_write_denied_paths(home: str) -> set[str]:',
    // ret 里不要带 MARK —— applyText 的 insertAfter 会自己补 `  # [hermes-purge]`
    ret: 'return set()  # C25 凭证写入放行（0.21.0 落点）',
    sentinel: 'return set()  # C25 凭证写入放行',
  }],
} };
