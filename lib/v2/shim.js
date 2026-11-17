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

function render(entries, logFile) {
  return `# hermes-purge v2 shim —— 由 \`purge revert\` 删除；手改会被下次 apply 覆盖
import json as _json
import os as _os
import sys as _sys

_LOG = ${toPy(logFile)}
_ENTRIES = ${toPy(entries)}


def _purge_log(rec):
    try:
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(_json.dumps(rec, ensure_ascii=False) + "\\n")
    except Exception:
        pass


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


_TARGETS = sorted({e.get("module") for e in _ENTRIES if e.get("module")})

for _m in _TARGETS:
    if _m in _sys.modules:
        try:
            _purge_apply(_m, _sys.modules[_m])
        except Exception:
            pass

try:
    import importlib.abc as _abc

    class _PurgeFinder(_abc.MetaPathFinder):
        _busy = set()

        def find_spec(self, fullname, path=None, target=None):
            if fullname not in _TARGETS or fullname in self._busy:
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
  const sps = platform.sitePackages(target);
  if (!sps.length) return { ok: false, reason: 'no-site-packages', written: [] };
  const logFile = path.join(target, '.hermes-purge', 'v2', 'shim.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const written = [];
  for (const sp of sps) {
    const shim = shimPath(sp);
    platform.writeText(shim, render(entries, logFile), { eol: '\n' });
    platform.writeText(pthPath(sp), 'import _hermes_purge_shim\n', { eol: '\n' });
    written.push(shim, pthPath(sp));
  }
  return { ok: true, written, entries: entries.length, log: logFile };
}

function uninstall(target, opts) {
  const skip = (opts && opts.skip) || null;   // 由事务管的文件不要在这里删（会破坏哈希校验）
  const removed = [];
  for (const sp of platform.sitePackages(target)) {
    for (const p of [shimPath(sp), pthPath(sp)]) {
      const rel = path.relative(target, p).replace(/\\/g, '/');
      if (skip && skip.has(rel)) continue;
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(p); }
    }
  }
  return { ok: true, removed };
}

/** 探测：pth 在 && shim 在 && 里面有这个 cap 的条目 */
function probe(target, cap) {
  const sps = platform.sitePackages(target);
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

module.exports = { install, uninstall, probe, readLog, PTH_NAME, SHIM_NAME, render };