'use strict';
/**
 * lib/v2/shim.js —— 运行时兜底层（venv site-packages 注入）
 *
 * 生成两件东西（都在宿主 venv 的 site-packages 里）：
 *   _hermes_purge.pth        → 一行 `import _hermes_purge_shim`
 *   _hermes_purge_shim.py    → 一张 monkeypatch 表 + 一个 meta_path 钩子
 *
 * 为什么这层能救场：
 *   - site-packages 的 .pth 在解释器启动时执行，cli / dashboard / gateway /
 *     桌面后端四个进程都会自动装上，不用改任何源码
 *   - 用 import 钩子「模块一被导入就替换」，不依赖符号出现在哪个文件
 *   - 源码层因版本变动失效时，这层仍然生效（只要符号名还在）
 * 局限（写清楚，不自欺）：
 *   - 只能替换「模块属性」；模块内部直接调本地名的场景无效 → 必须 AST 层
 *   - import 期就冻结的值（如 _YOLO_MODE_FROZEN）要靠 .env 的 env 提前注入
 */

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

const PTH_NAME = '_hermes_purge.pth';
const SHIM_NAME = '_hermes_purge_shim.py';

function shimPath(sp) { return path.join(sp, SHIM_NAME); }
function pthPath(sp) { return path.join(sp, PTH_NAME); }

/** JS 值 → python 字面量（JSON 的 true/false/null 在 python 里是语法错） */
function toPy(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(toPy).join(', ') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).map((k) => JSON.stringify(k) + ': ' + toPy(v[k])).join(', ') + '}';
  }
  return JSON.stringify(String(v));
}

/** 每轮埋点：宿主入口模块（0.21.0 的 agent.conversation_loop.run_conversation） */
const TURN_HOOKS = { 'agent.conversation_loop': 'run_conversation' };

/**
 * @param entries    shim 条目表（模块属性替换）
 * @param logFile    shim.log 绝对路径
 * @param metricsFile metrics.jsonl 绝对路径（缺省由 logFile 同目录推导）
 */
function render(entries, logFile, metricsFile) {
  const metrics = metricsFile || String(logFile || '').replace(/shim\.log$/, 'metrics.jsonl');
  return `# hermes-purge v2 shim —— 由 \`purge revert\` 删除；手改会被下次 apply 覆盖
import json as _json
import os as _os
import sys as _sys
import time as _time

_LOG = ${toPy(logFile)}
_METRICS = ${toPy(metrics)}
_ENTRIES = ${toPy(entries)}

# 一轮对话的入口：模块名 → 函数名。模块一被导入就包一层（fail-open）。
_TURN_HOOKS = ${toPy(TURN_HOOKS)}


def _purge_log(rec):
    try:
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(_json.dumps(rec, ensure_ascii=False) + "\\n")
    except Exception:
        pass


def _purge_record(rec):
    """埋点写盘：路径为空、盘只读、并发写坏都只吞掉，绝不影响宿主。"""
    if not _METRICS:
        return
    try:
        with open(_METRICS, "a", encoding="utf-8") as f:
            f.write(_json.dumps(rec, ensure_ascii=False) + "\\n")
    except Exception:
        pass


def _purge_now_iso():
    try:
        return _time.strftime("%Y-%m-%dT%H:%M:%S", _time.gmtime()) + ".%03dZ" % int((_time.time() % 1) * 1000)
    except Exception:
        return ""


def _purge_num(v):
    """任何值 → int 或 None。bool 也算数（True→1）。"""
    try:
        if v is None:
            return None
        if isinstance(v, bool):
            return int(v)
        f = float(v)
        if f != f:
            return None
        return int(f)
    except Exception:
        return None


def _purge_str(v):
    """任何值 → 非空字符串或 None（兼容 Enum / 数字 / None）。"""
    if v is None:
        return None
    try:
        if isinstance(v, str):
            s = v
        else:
            s = getattr(v, "value", None)
            if not isinstance(s, str):
                s = getattr(v, "name", None)
            if not isinstance(s, str):
                s = str(v)
        s = s.strip()
        return s or None
    except Exception:
        return None


def _purge_surface(agent):
    for name in ("platform", "surface", "platform_name", "channel"):
        try:
            got = _purge_str(getattr(agent, name, None))
        except Exception:
            got = None
        if got:
            return got
    return "unknown"


def _purge_model(agent):
    for name in ("model", "model_name"):
        try:
            got = _purge_str(getattr(agent, name, None))
        except Exception:
            got = None
        if got:
            return got
    return None


def _purge_approval_mode():
    """读当前审批模式。0.21.0 里它在 tools.approval，也可能被搬到 approval_context。"""
    for mod_name in ("tools.approval", "tools.approval_context"):
        try:
            mod = _sys.modules.get(mod_name)
            if mod is None:
                try:
                    __import__(mod_name)
                except Exception:
                    continue
                mod = _sys.modules.get(mod_name)
            fn = getattr(mod, "_get_approval_mode", None)
            if not callable(fn):
                continue
            val = fn()
            if val is None:
                return None
            got = _purge_str(val)
            if got:
                return got
        except Exception:
            continue
    return None


# 宿主的 token 计数是会话累计值（agent_init 里清零、每个 API call 累加），
# 所以「本轮用量」只能靠进/出各拍一次快照做差。字段不存在就是 None，不编数。
_TOKEN_KEYS = (("in", "session_input_tokens"), ("out", "session_output_tokens"))


def _purge_tokens_snapshot(agent):
    snap = {}
    for key, attr in _TOKEN_KEYS:
        try:
            snap[key] = _purge_num(getattr(agent, attr, None))
        except Exception:
            snap[key] = None
    return snap


def _purge_tokens_delta(agent, before):
    now = _purge_tokens_snapshot(agent)
    out = {}
    for key, _attr in _TOKEN_KEYS:
        a = (before or {}).get(key)
        b = now.get(key)
        if a is None or b is None:
            out[key] = None
        elif b >= a:
            out[key] = b - a
        else:
            out[key] = b          # 计数器被重置（换会话）→ 本轮自身累计值
    return out


def _purge_emit_turn(agent, turn_no, ok, before, elapsed):
    try:
        nudges = _purge_num(getattr(agent, "_purge_refusal_nudges", None))
    except Exception:
        nudges = None
    try:
        rec = {
            "event": "turn",
            "ts": _purge_now_iso(),
            "surface": _purge_surface(agent),
            "model": _purge_model(agent),
            "turn": turn_no,
            "refusals": {"nudges": nudges, "hit": bool(nudges and nudges > 0)},
            "approval": {"mode": _purge_approval_mode()},
            "tokens": _purge_tokens_delta(agent, before),
            "ok": bool(ok),
            "ms": int(elapsed * 1000) if elapsed is not None else None,
            "source": "shim",
        }
    except Exception:
        return
    _purge_record(rec)


def _purge_make_turn_wrapper(fn):
    """包住一轮对话：正常返回/抛异常都记一条，异常照原样往外抛（不吞）。"""

    def _purge_turn_wrapper(*args, **kwargs):
        agent = args[0] if args else kwargs.get("agent")
        try:
            turn_no = _purge_bump_turn()
        except Exception:
            turn_no = None
        try:
            before = _purge_tokens_snapshot(agent)
        except Exception:
            before = {}
        try:
            t0 = _time.time()
        except Exception:
            t0 = None
        ok = False
        try:
            result = fn(*args, **kwargs)
            ok = True
            return result
        finally:
            try:
                elapsed = (_time.time() - t0) if t0 is not None else None
            except Exception:
                elapsed = None
            try:
                _purge_emit_turn(agent, turn_no, ok, before, elapsed)
            except Exception:
                pass

    try:
        _purge_turn_wrapper._hermes_purge_turn = True
        _purge_turn_wrapper.__wrapped__ = fn
        _purge_turn_wrapper.__name__ = getattr(fn, "__name__", "run_conversation")
        _purge_turn_wrapper.__doc__ = getattr(fn, "__doc__", None)
    except Exception:
        pass
    return _purge_turn_wrapper


_TURN_STATE = {"n": 0}
try:
    import threading as _threading
    _TURN_LOCK = _threading.Lock()
except Exception:
    _TURN_LOCK = None


def _purge_bump_turn():
    """轮次序号。gateway 会并发跑轮，能加锁就加锁（加不上也不影响正确性之外的任何事）。"""
    if _TURN_LOCK is not None:
        try:
            with _TURN_LOCK:
                _TURN_STATE["n"] = int(_TURN_STATE.get("n") or 0) + 1
                return _TURN_STATE["n"]
        except Exception:
            pass
    _TURN_STATE["n"] = int(_TURN_STATE.get("n") or 0) + 1
    return _TURN_STATE["n"]


def _purge_apply(mod_name, module):
    for ent in _ENTRIES:
        if ent.get("module") != mod_name:
            continue
        attr = ent.get("attr")
        mode = ent.get("mode")
        if not attr or not hasattr(module, attr) and mode != "const":
            _purge_log({"ok": False, "module": mod_name, "attr": attr, "err": "attr-missing"})
            continue
        try:
            if mode == "const":
                setattr(module, attr, ent.get("value"))
            elif mode == "ret":
                val = ent.get("value")
                setattr(module, attr, (lambda v: (lambda *a, **k: v))(val))
            elif mode == "true":
                setattr(module, attr, (lambda *a, **k: True))
            elif mode == "false":
                setattr(module, attr, (lambda *a, **k: False))
            elif mode == "none":
                setattr(module, attr, (lambda *a, **k: None))
            elif mode == "tuple":
                val = tuple(ent.get("value") or [False, ""])
                setattr(module, attr, (lambda v: (lambda *a, **k: v))(val))
            else:
                _purge_log({"ok": False, "module": mod_name, "attr": attr, "err": "unknown-mode:" + str(mode)})
                continue
            _purge_log({"ok": True, "module": mod_name, "attr": attr, "mode": mode, "cap": ent.get("cap")})
        except Exception as e:
            _purge_log({"ok": False, "module": mod_name, "attr": attr, "err": repr(e)})


def _purge_after_import(mod_name, module):
    """模块导入后：装 turn 钩子。幂等（已包过就不再包）。"""
    try:
        fn_name = _TURN_HOOKS.get(mod_name)
        if not fn_name:
            return
        fn = getattr(module, fn_name, None)
        if fn is None:
            _purge_log({"ok": False, "module": mod_name, "attr": fn_name, "err": "turn-entry-missing"})
            return
        if getattr(fn, "_hermes_purge_turn", False):
            return
        setattr(module, fn_name, _purge_make_turn_wrapper(fn))
        _purge_log({"ok": True, "module": mod_name, "attr": fn_name, "mode": "turn-hook"})
    except Exception as e:
        try:
            _purge_log({"ok": False, "module": mod_name, "attr": "turn-hook", "err": repr(e)})
        except Exception:
            pass


_TARGETS = sorted({e.get("module") for e in _ENTRIES if e.get("module")})
_WATCH = sorted(set(_TARGETS) | set(_TURN_HOOKS))

for _m in _WATCH:
    if _m in _sys.modules:
        try:
            _purge_apply(_m, _sys.modules[_m])
        except Exception:
            pass
        _purge_after_import(_m, _sys.modules[_m])

try:
    import importlib.abc as _abc

    class _PurgeFinder(_abc.MetaPathFinder):
        _busy = set()

        def find_spec(self, fullname, path=None, target=None):
            if fullname not in _WATCH or fullname in self._busy:
                return None
            self._busy.add(fullname)
            try:
                spec = None
                for f in list(_sys.meta_path):
                    if f is self:
                        continue
                    try:
                        spec = f.find_spec(fullname, path, target)
                    except Exception:
                        spec = None
                    if spec is not None:
                        break
                if spec is None or spec.loader is None:
                    return None
                _orig = spec.loader

                class _PurgeLoader:
                    def create_module(self, spec2):
                        fn = getattr(_orig, "create_module", None)
                        return fn(spec2) if fn else None

                    def exec_module(self, module):
                        _orig.exec_module(module)
                        try:
                            _purge_apply(fullname, module)
                        except Exception:
                            pass
                        _purge_after_import(fullname, module)

                spec.loader = _PurgeLoader()
                return spec
            finally:
                self._busy.discard(fullname)

    _sys.meta_path.insert(0, _PurgeFinder())
except Exception:
    pass
`;
}

function install(target, entries, opts) {
  const o = opts || {};
  // py 传进来才能处理 pm 布局（venv 和代码根不在一层，issue #15）
  const sps = platform.sitePackages(target, o.py);
  if (!sps.length) return { ok: false, reason: 'no-site-packages', written: [] };
  const logFile = path.join(target, '.hermes-purge', 'v2', 'shim.log');
  const metricsFile = path.join(target, '.hermes-purge', 'v2', 'metrics.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const written = [];
  for (const sp of sps) {
    const shim = shimPath(sp);
    platform.writeText(shim, render(entries, logFile, metricsFile), { eol: '\n' });
    platform.writeText(pthPath(sp), 'import _hermes_purge_shim\n', { eol: '\n' });
    written.push(shim, pthPath(sp));
  }
  return { ok: true, written, entries: entries.length, log: logFile };
}

function uninstall(target, opts) {
  const skip = (opts && opts.skip) || null;   // 由事务管的文件不要在这里删（会破坏哈希校验）
  const removed = [];
  for (const sp of platform.sitePackages(target, (opts || {}).py)) {
    for (const p of [shimPath(sp), pthPath(sp)]) {
      const rel = path.relative(target, p).replace(/\\/g, '/');
      if (skip && skip.has(rel)) continue;
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p); }
    }
  }
  return { ok: true, removed };
}

/** 探测：pth 在 && shim 在 && 里面有这个 cap 的条目 */
function probe(target, cap, py) {
  const sps = platform.sitePackages(target, py);
  if (!sps.length) return { status: 'missing', detail: '找不到 venv site-packages' };
  let anyPth = false;
  let hit = false;
  for (const sp of sps) {
    if (!fs.existsSync(pthPath(sp))) continue;
    anyPth = true;
    const shim = shimPath(sp);
    if (!fs.existsSync(shim)) continue;
    const txt = fs.readFileSync(shim, 'utf8');
    if (txt.includes('"cap": ' + JSON.stringify(cap)) || txt.includes('"cap":' + JSON.stringify(cap))) hit = true;
  }
  if (hit) return { status: 'applied', detail: 'shim 已注入' };
  if (anyPth) return { status: 'pending', detail: 'pth 在，缺本 cap 条目' };
  return { status: 'pending', detail: '未注入 shim' };
}

function readLog(target) {
  const p = path.join(target, '.hermes-purge', 'v2', 'shim.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (e) { return { raw: l }; }
  });
}

module.exports = { install, uninstall, probe, readLog, PTH_NAME, SHIM_NAME, TURN_HOOKS, render };