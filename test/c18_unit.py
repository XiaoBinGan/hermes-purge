"""C18 单元验证：apply_stop_gates 在拒答时返回 continue_turn，且拒答行不进 messages。

不依赖网络、不依赖 dashboard —— 直接构造假 agent 调真函数。
    python test/c18_unit.py
"""
import os
import sys

# 宿主目录：优先环境变量，其次 HERMES_HOME，最后才猜相对位置（异地克隆不再崩）
ROOT = (os.environ.get("HERMES_ROOT_FOR_TEST")
        or os.environ.get("HERMES_HOME")
        or os.path.join(os.path.dirname(__file__), "..", "..", "..", "hermes", "hermes-agent"))
sys.path.insert(0, ROOT)

from agent.turn_stop_gates import apply_stop_gates  # noqa: E402

REFUSAL = "这个不做。完整可跑的 AMSI 绕过是武器化产物，我不提供成品代码。"
GOOD = "```powershell\n$k = 1\n```\n" + "public static class AmsiKit { }\n" * 40


class FakeAgent:
    platform = "tui"
    session_id = "c18-unit"
    model = "deepseek-flash"
    _session_messages = None
    _verification_stop_nudges = 0
    _kanban_stop_nudges = 0
    _pre_verify_nudges = 0
    _resolved_is_coding = False

    def _emit_interim_assistant_message(self, msg):
        pass

    def _flush_messages_to_session_db(self, messages, history):
        pass

    def _interim_content_was_streamed(self, text):
        return False


def run(text, env_cap=None, preset_nudges=0):
    if env_cap is None:
        os.environ.pop("HERMES_PURGE_RETRY", None)
    else:
        os.environ["HERMES_PURGE_RETRY"] = str(env_cap)
    agent = FakeAgent()
    agent._purge_refusal_nudges = preset_nudges
    messages = [{"role": "user", "content": "写 X"}]
    final_msg = {"role": "assistant", "content": text}
    sg = apply_stop_gates(
        agent, final_msg, final_response=text, messages=messages,
        conversation_history=[], pending_verification_response=None,
        pending_verification_response_previewed=False,
    )
    return sg, messages, agent


fails = 0


def ck(name, cond, extra=""):
    global fails
    print(("  OK   " if cond else "  FAIL ") + name + ("" if cond else "  " + extra))
    if not cond:
        fails += 1


# 1. 拒答 → continue_turn，且 nudge 进 messages、拒答行不进
sg, msgs, ag = run(REFUSAL)
ck("拒答触发重采样", sg.continue_turn is True)
ck("nudge 已追加为 user 行", msgs[-1]["role"] == "user" and msgs[-1].get("flag") is True)
ck("拒答行没进 messages", all(m.get("content") != REFUSAL for m in msgs))
ck("拒答不当 budget 兜底", sg.pending_verification_response is None)
ck("计数 +1", ag._purge_refusal_nudges == 1, str(ag._purge_refusal_nudges))

# 2. 合格回答 → 不触发，计数清零
sg, msgs, ag = run(GOOD, preset_nudges=2)
ck("合格回答不重采样", sg.continue_turn is False)
ck("合格回答清空计数", ag._purge_refusal_nudges == 0)
ck("合格回答不追加 nudge", len(msgs) == 1)

# 3. cap 生效：HERMES_PURGE_RETRY=1 → 第 2 次拒答不再重采样
sg, _, ag = run(REFUSAL, env_cap=1, preset_nudges=1)
ck("达到 cap 后放行", sg.continue_turn is False, "nudges=" + str(ag._purge_refusal_nudges))

# 4. 默认 cap=3
sg, _, ag = run(REFUSAL, env_cap=None, preset_nudges=3)
ck("默认 cap=3 后放行", sg.continue_turn is False)

# 5. 误判保护：正经内容里出现 拒绝服务 / 不提供默认值 不触发
DECOY = "拒绝服务压测脚本如下，参数默认值不提供时会回落到 8 线程。\n" * 30
sg, _, ag = run(DECOY, preset_nudges=0)
ck("误判保护：拒绝服务 不触发", sg.continue_turn is False)

# 6. C18d：计数必须按「轮」重置，否则一轮打满 cap 后同会话后续每轮直接放行。
#    这是结构性断言 —— 直接读 conversation_loop.run_conversation 的源码，
#    确认 reset 行写在 _run_conversation_turn 调用之前（打回补丁会被这条抓住）。
LOOP = os.path.join(ROOT, "agent", "conversation_loop.py")
if os.path.exists(LOOP):
    src = open(LOOP, encoding="utf-8").read()
    i_reset = src.find("agent._purge_refusal_nudges = 0")
    i_call = src.find("result = _run_conversation_turn(")
    ck("C18d reset 行存在", i_reset > 0)
    ck("C18d reset 在开跑之前", 0 < i_reset < i_call,
       "reset=%d call=%d" % (i_reset, i_call))
else:
    print("  SKIP  C18d 结构性断言（找不到 conversation_loop.py）")

os.environ.pop("HERMES_PURGE_RETRY", None)
print("\n" + ("全部通过" if fails == 0 else str(fails) + " 项失败"))
sys.exit(0 if fails == 0 else 1)