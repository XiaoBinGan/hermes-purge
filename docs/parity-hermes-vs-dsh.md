# Hermes-purge ↔ dsh-purge 覆盖面差距表

> 用途：回答「hermes-purge 是不是还差 dsh-purge 一截」这类问题。
> 只比**能力类**，不比条数：两边宿主不同，同一条行为要落的文件本来就不一样。

## 一、为什么感觉差很多

| 维度 | hermes-purge 3.2.0（之前） | dsh-purge | hermes-purge 3.3.0（现在） |
|------|------|------|------|
| 补丁数 | 31 | 73（68 applied / 2 skipped） | 41 |
| 落点模块 | ~10（approval / guardrails / prompt 拼装 / stream / transports / config / SOUL） | ~70 | ~18 |
| 提示词层 | 只搬**位置**（system → user、tail prefill），不改**内容** | 改内容 + 持久 `prompt-inject.md` override | 同左（位置与内容都不再被宿主的扫描器改写；override 走 `SOUL.md` + `prefill_messages_file`） |
| 内容防护层 | 一条都没有 | 覆盖（上下文文件、工具描述、prune、read caps、subagent depth） | 已覆盖（C21–C27、G03） |
| 沙箱/围栏 | 无 | fs fence / escalation / sandbox policy 全面放开 | 部分（C25 凭据目录写保护） |
| 会话与工具面 | 无 | 会话日志上传默认关、tool-ask failopen、plan mode 中性、deliverable 文案 | **未覆盖**（见第三节） |

结论：差的不是「条数」，是**层次**。3.3.0 之前 hermes 侧只清了「审批 / 拒答 / 采样」，
而 dsh 侧最大的一块是「宿主自带的提示词与内容安全层」。
最刺眼的一处：同样一段 `AGENTS.md`，dsh 上原样进系统提示词，hermes 上被判注入，
`_scan_context_content` 返回 `[BLOCKED: ... Content not loaded.]`，整份文件丢弃。

## 二、已对齐的能力类（3.3.0）

| dsh-purge 类 | 补丁 | hermes 落点 | 层 |
|------|------|------|------|
| SYSTEM_PROMPT_REPLACE_HEAD / persona purge | C13 C14 C16 C17 P01 P02 | 提示词搬运 + SOUL.md 覆写 + tail prefill | text/prompt |
| TOOL_RESULT_PRUNER_DISABLED | C27 | `would_proactively_prune` 恒 False | ast |
| READ_CAPS_RAISED | G03 | `tool_output.max_bytes/max_lines/max_line_length` | config |
| SUBAGENT_MAXDEPTH_RAISED | C26 | `MAX_DEPTH` 1 → 6 | text |
| FS_FENCE_DISABLED（凭据目录） | C25 | `deny_path_under` 恒 False | ast |
| 上下文/工具描述注入扫描 | C21 C22 C22b C24 | prompt_builder / threat_patterns / mcp_tool_schema | ast |
| skill 扫描拦截 | C23 C23b | skills_guard 恒放行 / 恒 safe | ast |
| 拒答重采样 + 流式消隐 | C18* C19* C20 | turn_stop_gates / stream_delivery / chat_completions | text |
| 审批 / 护栏 / 危险命令探测 | C01–C12 | approval* / tool_guardrails | ast+shim+text |

## 三、仍未覆盖（下一步候选）

| dsh-purge 类 | hermes 现状 | 难度 |
|------|------|------|
| SESSION_LOG_UPLOAD_DEFAULT_OFF | hermes 侧遥测默认值未改 | 低（找 config 键） |
| OFFICIAL_TOOL_ASK_FAILOPEN | `ask_user_question` 无对应开关 | 中 |
| PRESET_* / WEB_SURFACE_* 身份中性 | hermes 无 preset 体系 | 不适用 |
| PLAN_MODE 中性 | hermes `agent/plan_prompt.py` 未动 | 中 |
| 交付物文案（DELIVERABLE_DO_NOT） | hermes 无对应生成器 | 不适用 |
| 沙箱 escalate 全放开 | hermes 无独立 sandbox 层（`file_safety` 为主） | 低 |

## 四、怎么自己核

```bash
purge status            # 41 条 cap 逐条状态（applied/pending/drifted）
purge verify --level=2  # 每条 cap 的运行时断言
purge parity --out=f.json   # 跨机效果指纹（cap + 层），另一台 purge parity --diff=f.json
```
