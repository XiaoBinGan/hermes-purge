# dsh-purge 73 条 → hermes-purge 映射表

> 回答「为什么 hermes-purge 不直接补到 73 条」。
> 结论：73 条里约 21 条落在 Hermes **不存在**的设施上（无文件即无锚点），
> 其余能映射的已全部落成 hermes 侧 cap —— 3.4.0 后共 50 条。

## 一、分类统计

| 类别 | dsh 条数 | hermes 处理 |
|------|------|------|
| 审批 / 沙箱 / 围栏 | 12 | ✔ 映射（C01–C12、C25、C32）|
| 提示词身份 / persona | 12 | ✔ 8 条映射（C13/C14/C16、P01/P02），4 条不适用（无 web surface / preset / skill badge）|
| 内容防护层 | 8 | ✔ 映射（C21–C24、C27、G03、C26）|
| 工具循环 / 会话 / 流 | 13 | ✔ 11 条映射（C06、C11/C12、C13、C19*、C28、C30），2 条待办 |
| **Hermes 无此设施** | **21** | ✘ 无锚点（cordis preset / web-app UI / asar 解包 / anthropic-oauth / inspector 帧预算 / rewind / desktop-shell）|

「无此设施」不等于「漏了」：dsh 是 cordis 插件宿主，有 preset 体系、web-app 客户端 bundle、
asar 解包目录、anthropic-oauth 分支、inspector 帧预算；Hermes 是单体 Python 宿主，这些文件根本不存在。
强行造 73 条只能写成 `noop` 占位 —— 那是刷数字，不是补功能。

## 二、逐条映射（按 dsh patch id）

| dsh # | 名称 | hermes 对应 |
|------|------|------|
| 4 | SYSTEM_PROMPT_PERSONA | P01 / P02（SOUL.md 全量替换）|
| 5 | APPROVAL_NEVER_SENTENCE | C13 / C14 + G01 |
| 6 | SANDBOX_DENY_FILE_WRITE | C25 / C32 |
| 7 | SANDBOX_MODE_DEFAULT | G01 / G02 |
| 8 | APPROVAL_POLICY_DEFAULT | G01 / G02 |
| 13–17 | ESCALATION_* / FS_FENCE / FS_OBSERVATION | C25（写侧）+ C32（读侧）|
| 18 | REPEAT_TOOL_REMINDER_DISABLED | Hermes 无重复工具提醒器（不适用）|
| 19 | TOOL_RESULT_PRUNER_DISABLED | C27 |
| 21 | BASH_TIMEOUT_RESTORE | **待办**（hermes terminal timeout 未动）|
| 22 | READ_CAPS_RAISED | G03（4MB / 2 万行）|
| 23 | SUBAGENT_MAXDEPTH_RAISED | C26（1 → 6）|
| 24 | PRESET_FETCH_ENABLED | 不适用（无 preset 体系）|
| 25 | HARNESS_IDENTITY_STRIP | P01 / P02 |
| 26 | MINIMAL_PERSONA_PURGE | P01 / P02 |
| 29 | TOOL_WEB_UNTRUSTED_NEUTRAL | C24（描述扫描静音）|
| 32 / 43 / 53 | WEB_SURFACE_* / WEB_PRESET_* | 不适用（无 web surface）|
| 33 | TOOL_SHELL_DENIAL_PROMPT | C11 / C12 |
| 34 | SANDBOX_HINT_NEUTRAL | C13 |
| 35 | ESCALATION_NEVER_REJECT | C25 |
| 36 | TOOL_FS_ESCALATION_SCHEMA | C25 |
| 37 | SUBAGENT_SCOPE_LOCK_NEUTRAL | C26 |
| 38 | PERSONA_TEXT_PREFIX_ALIAS | P01 部分 |
| 39 / 40 / 42 | SESSION_V0_* / COMPLETE_PROMPT_* / SETTINGS_LEGACY_API | 不适用（dsh 版本兼容垫片）|
| 45 / 82 / 83 | DESKTOP_* / UPDATE_HANDOFF | 不适用（无 Electron 外壳）|
| 47 / 49 / 57 | ANTHROPIC_OAUTH_* / DEEPSEEK_SYSTEM_ROLE | 不适用（hermes 无该分支）|
| 48 | TOOL_SHELL_DELETE_MOVE_NEUTRAL | C11 / C12 |
| 50 / 72 | SESSION_REFERENCE_FRAMING / MESSAGES_SYSTEM_CURRENT | C13 |
| 51 | FRESH_SESSION_FULL_ACCESS | C06 |
| 52 | SESSION_LOG_UPLOAD_DEFAULT_OFF | **待办** |
| 54 | DELIVERABLE_DO_NOT | 不适用（无交付物生成器）|
| 55 | SYSTEM_PROMPT_REPLACE_HEAD | C13 / C14（位置）+ SOUL.md（内容）|
| 56 / 58 / 75 / 77 | REWIND_* | 不适用（无 rewind）|
| 59 | OFFICIAL_AUTO_REVIEW_PASSTHROUGH | **待办**（`agent/background_review.py`）|
| 60 | OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL | C01–C08 |
| 61 / 93 | SANDBOX_POLICY_* | C25 / C22 |
| 62 | OFFICIAL_TOOL_ASK_FAILOPEN | C28 部分（不阻塞）|
| 63 | OFFICIAL_PLAN_MODE_NEUTRAL | **C30** |
| 66 / 67 / 68 | SYSTEM_PROMPT_*_GUARD | C21 / C22 |
| 69 | MODEL_STREAM_RELEASE | C19e |
| 70 / 73 / 76 / 80 | PRESET_* | 不适用 |
| 78 / 87 / 89 / 90 / 91 / 92 | OVERLAY / HUNG_PROMPT / ASK_USER / STEERING / COOKIE / HEADER | 不适用（宿主设施不同）|
| 94 / 95 / 96 | SKILL_BADGE / INSPECTOR_* | 不适用 |

## 三、hermes 侧独有的补强（dsh 没有，因为 dsh 没这些层）

| id | 位置 | 说明 |
|----|------|------|
| C18 / C18b / C18c / C18d | `agent/turn_stop_gates.py` | 拒答干净重采样（实测最大杠杆）|
| C19b–C19e | `agent/stream_delivery.py` | 流式拒答消隐 |
| C20 / C20b | `agent/transports/chat_completions.py` | temperature 强制上线路 |
| C21 | `agent/prompt_builder.py` | 上下文文件注入扫描失效（AGENTS.md 不再 `[BLOCKED]`）|
| C22 / C22b | `tools/threat_patterns.py` | 威胁特征库空 |
| C23 / C23b / C31 / C31b | `tools/skills_guard.py` | skill 扫描全链放行 |
| C28 / C28b | `agent/empty_response_guard.py` | 空回答不判死、预算 8 |
| C29 / C29b | `agent/estop.py` | 急停哨兵失效 |
| C32 / C32b | `agent/file_safety.py` | 读侧围栏失效 |

## 四、待办（下一版候选）

1. `#21` terminal 命令超时 —— hermes `tools/terminal_tool.py` 的 `DEFAULT_TIMEOUT`
2. `#52` 会话日志上传默认关 —— 找 `hermes_cli` 里上传开关的默认值
3. `#59` auto-review passthrough —— `agent/background_review.py` 的自动复核拦截

核验命令：

```bash
purge status              # 50 条逐条状态
purge verify --level=2    # 每条运行时断言
```
