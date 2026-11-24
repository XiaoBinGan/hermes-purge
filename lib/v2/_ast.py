"""hermes-purge v2 —— AST 补丁助手（由 lib/v2/ast.js 以宿主自己的 python 调用）

用法：
  python _ast.py force-return <file> <symbol> <value>
  python _ast.py set-assign   <file> <name>   <value>
  python _ast.py locate       <file> <symbol>

<value> 是 python 源码片段（例如 '"off"' / 'True' / '(False, "")'）。
输出：一行 JSON。失败也输出 JSON（ok=false + reason），不抛栈。
"""
import ast
import json
import sys

# Windows 控制台默认 cp936：中文路径 / 中文报错一写就 UnicodeEncodeError，
# 上游只能看到「助手输出为空」。这里把 stdout 钉死成 UTF-8，emit 再走
# ensure_ascii，双保险。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - 老 python 没有 reconfigure
    pass

BOM = "\ufeff"
_BOM = {}  # path -> 原文件是否带 BOM（改完要原样写回去）


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")


def load(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8")
    # 带 BOM 的源码：留着 \ufeff 会让 ast.parse 直接 SyntaxError
    if text.startswith(BOM):
        _BOM[path] = True
        text = text[1:]
    return text


def save(path, text):
    out = (BOM if _BOM.get(path) else "") + text
    with open(path, "wb") as f:
        f.write(out.encode("utf-8"))


def eol_of(text):
    return "\r\n" if "\r\n" in text else "\n"


def find_func(tree, symbol):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == symbol:
            return node
    return None


def find_assign(tree, name):
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == name:
                    return node
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            return node
    return None


def cmd_force_return(path, symbol, value):
    text = load(path)
    tree = ast.parse(text, filename=path)
    fn = find_func(tree, symbol)
    if fn is None:
        return {"ok": False, "reason": "symbol-not-found", "symbol": symbol}
    if not fn.body:
        return {"ok": False, "reason": "empty-body", "symbol": symbol}
    first = fn.body[0]
    if first.lineno == fn.lineno:
        return {"ok": False, "reason": "single-line-body", "symbol": symbol}
    eol = eol_of(text)
    # CRLF 文件：split('\n') 后每行尾部还带 '\r'，直接 join 会写出 '\r\r\n'
    # （Windows 上就是把文件写坏）。先剥掉行尾 \r，再按原 eol 拼回去。
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in text.split("\n")]
    idx = first.lineno - 1
    indent = " " * first.col_offset
    stmt = indent + "return " + value
    # 幂等：已有同样的 return 就不重复插
    if lines[idx].strip() == "return " + value:
        return {"ok": True, "changed": False, "line": idx + 1, "symbol": symbol}
    lines.insert(idx, stmt)
    save(path, eol.join(lines))
    return {"ok": True, "changed": True, "line": idx + 1, "symbol": symbol,
            "inserted": stmt.strip()}


def cmd_set_assign(path, name, value):
    text = load(path)
    tree = ast.parse(text, filename=path)
    node = find_assign(tree, name)
    if node is None:
        return {"ok": False, "reason": "assign-not-found", "name": name}
    val = node.value
    lines = text.split("\n")
    offs = [0]
    for ln in lines:
        offs.append(offs[-1] + len(ln) + 1)

    def pos(lineno, col):
        return offs[lineno - 1] + col

    start = pos(val.lineno, val.col_offset)
    end = pos(val.end_lineno, val.end_col_offset)
    new_text = text[:start] + value + text[end:]
    if new_text == text:
        return {"ok": True, "changed": False, "line": node.lineno, "name": name}
    save(path, new_text)
    return {"ok": True, "changed": True, "line": node.lineno, "name": name}


def cmd_locate_batch(path, symbols):
    """一次解析、批量回答：probe 阶段大量 locate 同一文件的多个符号，逐个起进程太慢。"""
    text = load(path)
    tree = ast.parse(text, filename=path)
    out = {}
    for symbol in symbols:
        fn = find_func(tree, symbol)
        out[symbol] = ({"ok": True, "symbol": symbol, "line": fn.lineno,
                        "col": fn.col_offset, "end_line": fn.end_lineno}
                       if fn is not None else {"ok": False, "reason": "symbol-not-found"})
    return {"ok": True, "symbols": out}


def cmd_locate(path, symbol):
    text = load(path)
    tree = ast.parse(text, filename=path)
    fn = find_func(tree, symbol)
    if fn is None:
        return {"ok": False, "reason": "symbol-not-found", "symbol": symbol}
    return {"ok": True, "symbol": symbol, "line": fn.lineno,
            "col": fn.col_offset, "end_line": fn.end_lineno}


def main(argv):
    if len(argv) < 3:
        return {"ok": False, "reason": "usage"}
    cmd, path = argv[1], argv[2]
    try:
        if cmd == "force-return":
            return cmd_force_return(path, argv[3], " ".join(argv[4:]))
        if cmd == "set-assign":
            return cmd_set_assign(path, argv[3], " ".join(argv[4:]))
        if cmd == "locate-batch":
            return cmd_locate_batch(path, argv[3:])
        if cmd == "locate":
            return cmd_locate(path, argv[3])
        return {"ok": False, "reason": "unknown-cmd", "cmd": cmd}
    except SyntaxError as e:
        return {"ok": False, "reason": "syntax-error", "detail": str(e), "file": path}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "reason": type(e).__name__, "detail": str(e), "file": path}


if __name__ == "__main__":
    emit(main(sys.argv))