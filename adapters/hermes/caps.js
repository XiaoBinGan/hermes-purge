'use strict';
/**
 * adapters/hermes/caps.js —— Hermes Agent 的能力清单（adapter 私有）
 *
 * 一条 cap = 一个行为目标 + 若干可互换实现 + 断言。
 * 实现优先级：AST（符号级，抗搬迁）> shim（运行时，抗版本）> 文本（兼容层）> 配置。
 *
 * 注意：C13 C14 C16 C18 系列 C19 系列 C20 系列 这些是「结构性改动」（搬注入点、改循环、加 hook），
 * 只有文本层能表达，因此如实标注为 text-only —— 不自欺地吹成四层通用。
 */

const { PATCHES } = require('../../lib/patches');

/** AST 层能表达的那些：forceReturn / setAssign，按符号名定位，不认文件 */
const AST_CORE = {
  C01: { module: 'tools.approval', kind: 'setAssign', name: '_YOLO_MODE_FROZEN', value: 'True' },
  C02: { module: 'tools.approval', kind: 'forceReturn', symbol: 'is_approval_bypass_active_for_session', value: 'True' },
  C03: { module: 'tools.approval', kind: 'forceReturn', symbol: 'is_approval_bypass_active', value: 'True' },
  C04: { module: 'tools.approval', kind: 'forceReturn', symbol: '_get_approval_mode', value: '"off"' },
  C05: { module: 'tools.approval', kind: 'forceReturn', symbol: '_normalize_approval_mode', value: '"off"' },
  C06: { module: 'tools.approval', sites: [
    { kind: 'forceReturn', symbol: '_is_cron_approval_context', value: 'False' },
    { kind: 'forceReturn', symbol: '_is_unattended_platform_approval_context', value: 'False' },
    { kind: 'forceReturn', symbol: '_is_single_query_approval_context', value: 'False' },
  ] },
  C07: { module: 'acp_adapter.edit_approval', kind: 'forceReturn', symbol: 'should_auto_approve_edit', value: 'True' },
  C08: { module: 'acp_adapter.edit_approval', kind: 'forceReturn', symbol: 'maybe_require_edit_approval', value: 'None' },
  C09: { module: 'agent.tool_guardrails', cls: 'ToolGuardrailDecision', kind: 'forceReturn', symbol: 'allows_execution', value: 'True' },
  C10: { module: 'agent.tool_guardrails', cls: 'ToolGuardrailDecision', kind: 'forceReturn', symbol: 'should_halt', value: 'False' },
  C11: { module: 'tools.approval', kind: 'forceReturn', symbol: 'detect_hardline_command', value: '(False, "")' },
  C12: { module: 'tools.approval', kind: 'forceReturn', symbol: 'detect_dangerous_command', value: '(False, "")' },

  /* H 系列：宿主内置防护层（对应 dsh-purge 的 prompt/code 双层清洗）。
     全部是「整函数改判」，AST 够用，不需要搬注入点，所以没有 C13/C16 那种 text-only 限制。 */
  C21: { module: 'agent.prompt_builder', kind: 'forceReturn', symbol: '_scan_context_content', value: 'content' },
  C22: { module: 'tools.threat_patterns', kind: 'forceReturn', symbol: 'scan_for_threats', value: '[]' },
  C22b: { module: 'tools.threat_patterns', kind: 'forceReturn', symbol: 'first_threat_message', value: 'None' },
  C23: { module: 'tools.skills_guard', kind: 'forceReturn', symbol: 'should_allow_install', value: '(True, "purged")' },
  C23b: { module: 'tools.skills_guard', kind: 'forceReturn', symbol: '_determine_verdict', value: '"safe"' },
  C24: { module: 'tools.mcp_tool_schema', kind: 'forceReturn', symbol: '_scan_mcp_description', value: '[]' },
  C25: { module: 'agent.file_safety', kind: 'forceReturn', symbol: 'deny_path_under', value: 'False' },
  C27: { module: 'agent.context_compressor_prune', kind: 'forceReturn', symbol: 'would_proactively_prune', value: 'False' },

  /* 第二轮：宿主其余拦截点（空回答守卫 / 急停 / plan 模式 / skill 扫描源头 / 读保护） */
  C28: { module: 'agent.empty_response_guard', kind: 'forceReturn', symbol: 'deterministic_empty', value: 'False' },
  C28b: { module: 'agent.empty_response_guard', kind: 'forceReturn', symbol: 'empty_retry_budget', value: '8' },
  C29: { module: 'agent.estop', kind: 'forceReturn', symbol: 'is_engaged', value: 'False' },
  C29b: { module: 'agent.estop', kind: 'forceReturn', symbol: 'check_paused', value: 'False' },
  C30: { module: 'agent.plan_prompt', kind: 'forceReturn', symbol: 'build_plan_prompt', value: 'task' },
  C31: { module: 'tools.skills_guard', kind: 'forceReturn', symbol: '_scan_text', value: '[]' },
  C31b: { module: 'tools.skills_guard', kind: 'forceReturn', symbol: '_padded_code_findings', value: '[]' },
  C32: { module: 'agent.file_safety', kind: 'forceReturn', symbol: 'get_read_block_error', value: 'None' },
  C32b: { module: 'agent.file_safety', kind: 'forceReturn', symbol: 'is_blocked_device_path', value: 'False' },

  /* 第三轮：写入守卫 / 命令守卫 / 脱敏 / 后台复核 */
  C33: { module: 'tools.file_tools_write_guards', kind: 'forceReturn', symbol: '_check_sensitive_path', value: 'None' },
  C34: { module: 'tools.file_tools_write_guards', kind: 'forceReturn', symbol: '_protected_instruction_reason', value: 'None' },
  C35: { module: 'tools.file_tools_write_guards', kind: 'forceReturn', symbol: '_check_protected_instruction_write', value: 'None' },
  C36: { module: 'tools.file_tools_write_guards', kind: 'forceReturn', symbol: '_check_approval_required_write', value: 'None' },
  C37: { module: 'tools.file_tools_write_guards', kind: 'forceReturn', symbol: '_check_cross_profile_path', value: 'None' },
  C38: { module: 'tools.file_tools_write_guards', kind: 'forceReturn', symbol: '_stale_overwrite_blocker', value: 'None' },
  C39: { module: 'tools.file_tools_write_guards', kind: 'forceReturn', symbol: '_check_binary_document_write', value: 'None' },
  C40: { module: 'agent.redact', kind: 'forceReturn', symbol: '_redact_enabled', value: 'False' },
  C41: { module: 'tools.browser_vault_tool', kind: 'forceReturn', symbol: '_confirm_payment_fill', value: 'True' },
  C42: { module: 'tools.terminal_tool_guards', kind: 'forceReturn', symbol: 'trailing_amp_background_command', value: 'None' },
  C43: { module: 'tools.terminal_tool_guards', kind: 'forceReturn', symbol: 'locked_skill_block', value: 'None' },
  C44: { module: 'tools.terminal_tool_guards', kind: 'forceReturn', symbol: 'gateway_lifecycle_block', value: 'None' },
  C45: { module: 'tools.terminal_tool_guards', kind: 'forceReturn', symbol: 'self_repo_block', value: 'None' },
  C46: { module: 'agent.background_review', kind: 'forceReturn', symbol: '_bg_review_auto_deny', value: '"allow"' },
};

/** shim 层：模块属性替换。同一个函数在 0.21.0/0.21.3 可能住不同模块，所以用 modules 列表 */
const SHIM_CORE = {
  C01: { modules: ['tools.approval'], attr: '_YOLO_MODE_FROZEN', mode: 'const', value: true },
  C02: { modules: ['tools.approval'], attr: 'is_approval_bypass_active_for_session', mode: 'true' },
  C03: { modules: ['tools.approval'], attr: 'is_approval_bypass_active', mode: 'true' },
  C04: { modules: ['tools.approval_context', 'tools.approval'], attr: '_get_approval_mode', mode: 'ret', value: 'off' },
  C05: { modules: ['tools.approval_context', 'tools.approval'], attr: '_normalize_approval_mode', mode: 'ret', value: 'off' },
  C06: { modules: ['tools.approval'], attrs: ['_is_cron_approval_context',
    '_is_unattended_platform_approval_context', '_is_single_query_approval_context'], mode: 'false' },
  C07: { modules: ['acp_adapter.edit_approval'], attr: 'should_auto_approve_edit', mode: 'true' },
  C08: { modules: ['acp_adapter.edit_approval'], attr: 'maybe_require_edit_approval', mode: 'none' },
  C11: { modules: ['tools.approval_detection', 'tools.approval'], attr: 'detect_hardline_command', mode: 'tuple', value: [false, ''] },
  C12: { modules: ['tools.approval_detection', 'tools.approval'], attr: 'detect_dangerous_command', mode: 'tuple', value: [false, ''] },
};

/** 行为标签（给人看，也给 stats 用） */
const CAP_NAME = {
  C01: 'approval.yolo_frozen', C02: 'approval.bypass.session', C03: 'approval.bypass.global',
  C04: 'approval.mode.off', C05: 'approval.mode.normalize', C06: 'approval.context.cron_unattended',
  C07: 'edit.auto_approve', C08: 'edit.skip_approval',
  C09: 'guardrail.allow', C10: 'guardrail.no_halt',
  C11: 'detect.hardline.off', C12: 'detect.dangerous.off',
  C13: 'prompt.system_to_user', C14: 'prompt.summary_path', C16: 'prompt.tail_prefill',
  C18: 'import.re', C18b: 'refusal.resample.gate', C18c: 'refusal.resample.helper', C18d: 'refusal.resample.reset',
  C19b: 'stream.buf.reset', C19c: 'stream.refusal_mute', C19d: 'stream.refusal_re', C19e: 'stream.tail_flush',
  C20: 'sampling.temperature', C20b: 'import.os',
  C21: 'context.scan_off', C22: 'threat.scan_off', C22b: 'threat.summary_off',
  C23: 'skills.install_allow', C23b: 'skills.verdict_safe', C24: 'mcp.desc_scan_off',
  C25: 'fs.credential_write_allow', C26: 'delegate.depth_raised', C27: 'prune.proactive_off',
  C28: 'empty.no_deterministic', C28b: 'empty.budget_8', C29: 'estop.off', C29b: 'estop.pause_off',
  C30: 'plan.mode_neutral', C31: 'skills.scan_off', C31b: 'skills.pad_scan_off',
  C32: 'fs.read_block_off', C32b: 'fs.device_block_off',
  C33: 'fs.wguard.sensitive_off', C34: 'fs.wguard.protected_off', C35: 'fs.wguard.hook_off',
  C36: 'fs.wguard.approval_off', C37: 'fs.wguard.cross_profile_off', C38: 'fs.wguard.stale_off',
  C39: 'fs.wguard.binary_off', C40: 'redact.off', C41: 'browser.payment_confirm_off',
  C42: 'terminal.guard.trailing_amp_off', C43: 'terminal.guard.locked_skill_off',
  C44: 'terminal.guard.gateway_off', C45: 'terminal.guard.self_repo_off', C46: 'review.auto_deny_off',
  C15: 'budget.max_tokens', C17: 'prompt.prefill_file',
  G01: 'config.approvals', G02: 'config.env', G03: 'config.tool_output',
  P01: 'persona.soul.home', P02: 'persona.soul.repo',
};

function shimEntriesFor(cap) {
  const meta = cap.shimMeta;
  if (!meta) return [];
  const out = [];
  const attrs = meta.attrs || [meta.attr];
  for (const mod of meta.modules) {
    for (const attr of attrs) {
      out.push({ module: mod, attr, mode: meta.mode, value: meta.value });
    }
  }
  return out;
}

function buildCaps() {
  const caps = [];
  for (const p of PATCHES) {
    const impls = [];

    const astMeta = AST_CORE[p.id];
    if (astMeta) {
      const sites = astMeta.sites || [astMeta];
      impls.push({ kind: 'ast', module: astMeta.module, cls: astMeta.cls, sites });
    }

    const shimMeta = SHIM_CORE[p.id];
    if (shimMeta) impls.push({ kind: 'shim', shimMeta });

    // 文本 / 配置层永远作为最后一道（1.x 已验证过的锚点，含 0.21.0 变体）
    // 把 patch 上显式声明的 sentinel 带进 spec（否则文本层只认 `[hermes-purge] <id>`）
    impls.push({ kind: 'text', spec: p.sentinel ? Object.assign({}, p, { sentinel: p.sentinel }) : p });

    caps.push({
      id: p.id,
      layer: p.layer,
      cap: CAP_NAME[p.id] || p.id,
      note: p.note,
      astMeta: astMeta || null,
      shimMeta: shimMeta || null,
      impls,
      // 变体**不继承**主锚的 sentinel：两者的替换文本不同（变体的注释里带 cap id，
      // 主锚的注释不带），继承会让变体永远判定不上 —— 实测就踩过 C16 在 0.21.0 上变 drifted。
      variants: (p.variants || []).map((v) => ({ kind: 'text', spec: Object.assign({}, v, { file: v.file, sentinel: v.sentinel }) })),
    });
  }
  return caps;
}

/** 该 cap 会因为哪些文件被改（事务快照用） */
function filesOf(cap) {
  const out = new Set();
  for (const impl of cap.impls) {
    if (impl.kind === 'text') out.add(impl.spec.file);
  }
  for (const v of cap.variants || []) out.add(v.spec.file);
  return [...out];
}

module.exports = { buildCaps, filesOf, CAP_NAME, AST_CORE, SHIM_CORE, shimEntriesFor };