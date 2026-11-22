"""hermes-purge 的 Hermes 插件（无损扩展）。

它不是补丁：只是往 Hermes 的插件系统里注册两件东西，删掉目录就没了，
上游升级也不会留下残迹。

1. ``/purge [status|report|doctor|stats]`` —— 会话内直接看状态
2. ``purge_status`` 工具 —— 让 agent 自己能回答「补丁现在开着吗」

实现方式是把 ``purge status --json`` 拉过来解析。所有调用都有超时与缓存；
拿不到就如实回一句「找不到 purge CLI」，不猜。
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_CACHE_TTL = 5.0
_cache: dict = {"at": 0.0, "data": None}

# 安装时由 `purge plugin install` 写入，指向本机 purge CLI
_HERE = Path(__file__).resolve().parent
_PATH_FILE = _HERE / "path.json"


def _cli() -> list[str] | None:
    """返回调用 purge CLI 的命令前缀，找不到就 None。"""
    try:
        spec = json.loads(_PATH_FILE.read_text(encoding="utf-8"))
    except Exception:
        spec = {}
    cli = spec.get("cli")
    node = spec.get("node") or shutil.which("node")
    if not cli or not node:
        return None
    if not Path(cli).exists():
        return None
    return [node, cli]


_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _plain(text: str) -> str:
    """purge CLI 在非 TTY 下还有几处直接拼了颜色码，交给终端前先剥掉。"""
    return _ANSI.sub("", text)


def _run(args: list[str], timeout: float = 25.0) -> str:
    prefix = _cli()
    if prefix is None:
        return "找不到 purge CLI（先跑 purge plugin install，或确认 ~/.hermes-purge 还在）"
    try:
        r = subprocess.run(prefix + args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "purge 命令超时（%.0fs）" % timeout
    except Exception as exc:  # noqa: BLE001
        return "purge 命令失败：%s" % exc
    out = (r.stdout or "").strip()
    if r.returncode != 0 and not out:
        out = (r.stderr or "").strip()
    return _plain(out) or "（无输出）"


def _status_json() -> dict | None:
    """带缓存地拿 status --json；失败返回 None。"""
    now = time.time()
    if _cache["data"] and now - _cache["at"] < _CACHE_TTL:
        return _cache["data"]  # type: ignore[return-value]
    prefix = _cli()
    if prefix is None:
        return None
    try:
        r = subprocess.run(prefix + ["status", "--json"], capture_output=True, text=True, timeout=25)
        data = json.loads((r.stdout or "").strip() or "{}")
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    _cache.update({"at": now, "data": data})
    return data


def _summary() -> str:
    if _cli() is None:
        return "找不到 purge CLI（先跑 purge plugin install，或确认 purge 仓库还在）"
    d = _status_json()
    if not d:
        return "purge 命令跑不通（status --json 没有输出）。手动试：purge status"
    rows = d.get("rows") or []
    applied = [r for r in rows if r.get("status") == "applied"]
    pending = [r for r in rows if r.get("status") == "pending"]
    drifted = [r for r in rows if r.get("status") not in ("applied", "pending")]
    impls: dict = {}
    for r in applied:
        k = r.get("impl") or "?"
        impls[k] = impls.get(k, 0) + 1
    verdict = "已开启" if rows and len(applied) == len(rows) else ("未开启" if not applied else "部分生效")
    lines = [
        "purge %s · %d/%d 生效（待应用 %d · 不可用 %d）" % (verdict, len(applied), len(rows), len(pending), len(drifted)),
        "实现层：" + (" · ".join("%s %d" % (k, v) for k, v in sorted(impls.items())) or "—"),
        "宿主：" + str(d.get("target") or "?"),
    ]
    if pending:
        lines.append("待应用：" + ", ".join(str(r.get("id")) for r in pending[:8]) + ("…" if len(pending) > 8 else ""))
    if drifted:
        lines.append("不可用：" + ", ".join(str(r.get("id")) for r in drifted[:8]) + ("…" if len(drifted) > 8 else ""))
    return "\n".join(lines)


def _cmd_purge(raw_args: str) -> str:
    """/purge [status|report|doctor|stats]"""
    arg = (raw_args or "").strip().lower()
    if arg in ("", "status", "s"):
        return _summary()
    if arg == "report":
        out = _run(["report", "--out", str(Path.home() / "purge-report.html")])
        return out + "\n（用浏览器打开 ~/purge-report.html）"
    if arg == "doctor":
        return _run(["doctor"])
    if arg == "stats":
        return _run(["stats"])
    if arg in ("help", "-h", "--help"):
        return "用法：/purge [status|report|doctor|stats]"
    return "未知子命令：%s\n用法：/purge [status|report|doctor|stats]" % arg


def _tool_purge_status(**_kwargs) -> dict:
    """给 agent 用的工具：返回结构化状态。"""
    d = _status_json()
    if not d:
        return {"ok": False, "reason": "purge CLI 不可用（未安装或路径失效）"}
    rows = d.get("rows") or []
    applied = sum(1 for r in rows if r.get("status") == "applied")
    return {
        "ok": True,
        "verdict": "on" if rows and applied == len(rows) else ("off" if not applied else "partial"),
        "applied": applied,
        "total": len(rows),
        "drifted": [r.get("id") for r in rows if r.get("status") not in ("applied", "pending")],
        "impls": {k: sum(1 for r in rows if r.get("impl") == k) for k in {r.get("impl") for r in rows if r.get("impl")}},
        "target": d.get("target"),
        "text": _summary(),
    }


def register(ctx) -> None:
    ctx.register_command(
        "purge",
        _cmd_purge,
        description="查看 hermes-purge 状态（status / report / doctor / stats）",
        args_hint="[status|report|doctor|stats]",
    )
    ctx.register_tool(
        "purge_status",
        "hermes-purge",
        {
            "name": "purge_status",
            "description": "查询 hermes-purge 是否开启：返回 verdict(on/off/partial)、生效条数、不可用项、实现层分布。只读。",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        _tool_purge_status,
        description="hermes-purge 状态查询",
        emoji="🧩",
    )
    logger.debug("hermes-purge plugin registered (/purge + purge_status)")
