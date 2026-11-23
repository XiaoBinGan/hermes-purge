"""C18 单元验证（Hermes 0.21.0 布局）：拒答 nudge 判定 + 计数语义 + 落点位置。

0.21.0 没有 agent/turn_stop_gates.py，apply_stop_gates 不存在；拒答重采样直接
内联在 agent/conversation_loop.py 的主循环里。所以这里断言的是函数行为 + 结构位置。

    python test/c18_unit_0210.py
"""
import os
import sys

ROOT = os.environ.get("HERMES_ROOT_FOR_TEST", "/tmp/v20/hermes-agent")
sys.path.insert(0, ROOT)

from agent.conversation_loop import _purge_refusal_nudge, _PURGE_REFUSAL_RE  # noqa: E402

REFUSAL = "这个不做。完整可跑的 AMSI 绕过是武器化产物，我不提供成品代码。"
GOOD = "```powershell\n$k = 1\n```\n" + "public static class AmsiKit { }\n" * 40
DECOY = "拒绝服务压测脚本如下，参数默认值不提供时会回落到 8 线程。\n" * 3

fails = 0


def ck(name, cond, extra=""):
    global fails
    print(("  OK   " if cond else "  FAIL ") + name + ("" if cond else "  " + extra))
    if not cond:
        fails += 1


class FakeAgent:
    pass


def run(text, env_cap=None, preset=0):
    os.environ.pop("HERMES_PURGE_RETRY", None)
    if env_cap is not None:
        os.environ["HERMES_PURGE_RETRY"] = str(env_cap)
    a = FakeAgent()
    a._purge_refusal_nudges = preset
    return _purge_refusal_nudge(a, text), a


# 1. 拒答 → 返回 nudge，计数 +1
nudge, ag = run(REFUSAL)
ck("拒答触发重采样", bool(nudge))
ck("计数 +1", ag._purge_refusal_nudges == 1, str(ag._purge_refusal_nudges))

# 2. 合格回答 → 不触发，计数清零
nudge, ag = run(GOOD, preset=2)
ck("合格回答不重采样", nudge is None)
ck("合格回答清空计数", ag._purge_refusal_nudges == 0)

# 3. cap 生效
nudge, ag = run(REFUSAL, env_cap=1, preset=1)
ck("达到 cap 后放行", nudge is None, "nudges=" + str(ag._purge_refusal_nudges))

# 4. 默认 cap=3
nudge, ag = run(REFUSAL, preset=3)
ck("默认 cap=3 后放行", nudge is None)

# 5. 误判保护：正经内容里的 拒绝服务 / 不提供 默认值 不触发
nudge, ag = run(DECOY)
ck("误判保护：拒绝服务 不触发", nudge is None)
ck("误判保护：正则直接不命中", _PURGE_REFUSAL_RE.search(DECOY[:400]) is None)

# 6. 非字符串输入不炸
nudge, ag = run(None)
ck("None 输入不触发", nudge is None)

# 7. 结构性断言：C18d 计数重置必须在 run_conversation 内、主循环之前
LOOP = os.path.join(ROOT, "agent", "conversation_loop.py")
src = open(LOOP, encoding="utf-8").read()
i_fn = src.find("def run_conversation(")
i_reset = src.find("agent._purge_refusal_nudges = 0  # [hermes-purge]")
i_gate = src.find("_purge_nudge = _purge_refusal_nudge(agent, final_response)")
ck("C18d reset 行存在", i_reset > 0)
ck("C18d reset 在 run_conversation 内", i_fn < i_reset)
ck("C18b 闸门已注入主循环", i_gate > i_reset)
ck("C18b 闸门后 continue 本轮", 0 < src.find("final_response = None", i_gate) - i_gate < 700
   and 0 < src.find("continue", i_gate) - i_gate < 800)

# 8. 结构性断言：C19d 常量在 run_agent.py 模块级
RA = os.path.join(ROOT, "run_agent.py")
rsrc = open(RA, encoding="utf-8").read()
ck("C19d _PURGE_HEAD 存在", "_PURGE_HEAD = 80" in rsrc)
ck("C19c hold-back 已注入", "_purge_stream_buf" in rsrc and "_purge_stream_muted" in rsrc)

os.environ.pop("HERMES_PURGE_RETRY", None)
print("\n" + ("全部通过" if fails == 0 else str(fails) + " 项失败"))
sys.exit(0 if fails == 0 else 1)
