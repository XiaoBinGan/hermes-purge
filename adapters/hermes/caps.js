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
  C15: 'budget.max_tokens', C17: 'prompt.prefill_file', G01: 'config.approvals', G02: 'config.env',
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