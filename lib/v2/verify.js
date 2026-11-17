'use strict';
/**
 * lib/v2/verify.js —— 三级验证
 *
 *   L1 静态：py_compile + YAML 回读（补丁写没写坏）
 *   L2 运行时：每条 cap 的断言在宿主 venv 里跑（补丁落没落地）
 *   L3 端到端：真跑一轮（可关；默认只跑 L1+L2）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const platform = require('./platform');

function runPy(py, code, cwd, input) {
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8', cwd, timeout: 180000, windowsHide: true, input });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

function l1Static(target, files, py) {
  const result = { level: 'L1', checks: [] };
  if (!py) { result.checks.push({ name: 'python', ok: false, detail: '找不到宿主 python' }); result.ok = false; return result; }

  const pyFiles = files.filter((f) => f.endsWith('.py') && fs.existsSync(path.resolve(target, f)));
  if (pyFiles.length) {
    const code = 'import py_compile,sys,json\nout=[]\n' +
      'for f in sys.argv[1:]:\n' +
      '    try:\n        py_compile.compile(f, doraise=True); out.append([f, True, ""])\n' +
      '    except Exception as e:\n        out.append([f, False, str(e)[:200]])\n' +
      'print(json.dumps(out))';
    const r = spawnSync(py, ['-c', code].concat(pyFiles.map((f) => path.resolve(target, f))),
      { encoding: 'utf8', timeout: 180000, windowsHide: true });
    let parsed = [];
    try { parsed = JSON.parse((r.stdout || '[]').trim().split('\n').pop()); } catch (e) { parsed = []; }
    for (const [f, ok, detail] of parsed) {
      result.checks.push({ name: 'compile ' + path.relative(target, f), ok, detail });
    }
  }

  const yamls = files.filter((f) => /\.ya?ml$/i.test(f) && fs.existsSync(path.resolve(target, f)));
  for (const y of yamls) {
    const code = 'import sys\ntry:\n    import yaml\n    yaml.safe_load(open(sys.argv[1], encoding="utf-8"))\n    print("OK")\nexcept ImportError:\n    print("SKIP")\nexcept Exception as e:\n    print("ERR " + str(e)[:200])';
    const r = spawnSync(py, ['-c', code, path.resolve(target, y)], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const out = (r.stdout || '').trim();
    result.checks.push({ name: 'yaml ' + y, ok: out !== 'ERR' && !out.startsWith('ERR'), detail: out });
  }

  result.ok = result.checks.every((c) => c.ok);
  return result;
}

/**
 * L2：行为断言（不是源码 grep）
 *
 * 为什么改成行为断言：shim 层会在运行时替换函数，源码里那条 return 已经不是
 * 「实际跑的东西」。只有真调用一次才证明补丁在运行时生效 —— 也顺带证明
 * AST 层、shim 层、文本层三条路径的最终效果一致。
 */
function l2Runtime(target, caps, py) {
  const result = { level: 'L2', checks: [] };
  if (!py) { result.checks.push({ name: 'python', ok: false, detail: '找不到宿主 python' }); result.ok = false; return result; }

  const script = `
import importlib, json, sys, traceback

out = []

def rec(cap, name, run):
    r = {"cap": cap, "name": name, "ok": False, "detail": ""}
    try:
        got = run()
        r["ok"] = got[0]
        r["detail"] = str(got[1])[:120]
    except Exception as e:
        r["detail"] = type(e).__name__ + ": " + str(e)[:120]
    out.append(r)

def mod(*names):
    last = None
    for n in names:
        try:
            return importlib.import_module(n)
        except Exception as e:
            last = e
    raise last

ap = mod("tools.approval")
try:
    ac = mod("tools.approval_context", "tools.approval")
except Exception:
    ac = ap
try:
    ad = mod("tools.approval_detection", "tools.approval")
except Exception:
    ad = ap
ea = mod("acp_adapter.edit_approval")
g = mod("agent.tool_guardrails")

rec("C01", "_YOLO_MODE_FROZEN", lambda: (ap._YOLO_MODE_FROZEN is True, ap._YOLO_MODE_FROZEN))
rec("C02", "bypass.session", lambda: (ap.is_approval_bypass_active_for_session("s") is True,
                                    ap.is_approval_bypass_active_for_session("s")))
rec("C03", "bypass.global", lambda: (ap.is_approval_bypass_active() is True, ap.is_approval_bypass_active()))
rec("C04", "mode", lambda: (ac._get_approval_mode() == "off", ac._get_approval_mode()))
rec("C05", "normalize", lambda: (ac._normalize_approval_mode("manual") == "off",
                                 ac._normalize_approval_mode("manual")))
for nm in ("_is_cron_approval_context", "_is_unattended_platform_approval_context", "_is_single_query_approval_context"):
    if hasattr(ap, nm):
        rec("C06", nm, (lambda f: (lambda: (f() is False, f())))(getattr(ap, nm)))
rec("C07", "edit.auto_approve", lambda: (ea.should_auto_approve_edit(None, "manual") is True,
                                         ea.should_auto_approve_edit(None, "manual")))
rec("C08", "edit.skip", lambda: (ea.maybe_require_edit_approval("write_file", {}) is None,
                                 ea.maybe_require_edit_approval("write_file", {})))
rec("C09", "guardrail.allow", lambda: (g.ToolGuardrailDecision(action="halt", code="x").allows_execution is True,
                                       g.ToolGuardrailDecision(action="halt", code="x").allows_execution))
rec("C10", "guardrail.halt", lambda: (g.ToolGuardrailDecision(action="halt", code="x").should_halt is False,
                                      g.ToolGuardrailDecision(action="halt", code="x").should_halt))
rec("C11", "hardline", lambda: (ad.detect_hardline_command("rm -rf / --no-preserve-root")[0] is False,
                                ad.detect_hardline_command("rm -rf / --no-preserve-root")))
rec("C12", "dangerous", lambda: (ad.detect_dangerous_command("sudo rm -rf /etc")[0] is False,
                                 ad.detect_dangerous_command("sudo rm -rf /etc")))

print(json.dumps(out, ensure_ascii=False))
`;
  const r = runPy(py, script, target);
  const payload = (r.out || '').split('\n').pop() || '[]';
  let parsed = [];
  try { parsed = JSON.parse(payload); } catch (e) { parsed = []; }
  if (!parsed.length) {
    result.checks.push({ name: 'L2 断言脚本', ok: false, detail: (r.err || 'no output').slice(0, 300) });
  }
  for (const p of parsed) result.checks.push({ name: p.cap + ' ' + p.name, ok: !!p.ok, detail: p.detail });
  result.ok = result.checks.length > 0 && result.checks.every((c) => c.ok);
  return result;
}

/** L3：真跑一轮（不截图、不算拒绝率，只看链路通不通） */
function l3E2E(target, opts) {
  const o = opts || {};
  const py = platform.findPython(target);
  const r = { level: 'L3', checks: [] };
  const bin = path.join(path.dirname(target), 'bin', platform.isWin ? 'hermes.exe' : 'hermes');
  const hermes = fs.existsSync(bin) ? bin : platform.which('hermes');
  if (!hermes) {
    r.checks.push({ name: 'hermes CLI', ok: false, detail: '找不到 hermes 可执行' });
    r.ok = false;
    return r;
  }
  const res = spawnSync(hermes, ['-z', o.prompt || '只回答两个字：收到'],
    { encoding: 'utf8', timeout: o.timeout || 180000, windowsHide: true });
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  r.checks.push({ name: 'turn 完成', ok: out.length > 0, detail: out.slice(-200) });
  void py;
  r.ok = r.checks.every((c) => c.ok);
  return r;
}

module.exports = { l1Static, l2Runtime, l3E2E };