'use strict';
/**
 * lib/v2/impls.js —— 四种实现的 probe / apply
 *
 * 所有读写都走 platform（保留 BOM 与换行），所以 Windows 上的 CRLF 文件改完还是 CRLF。
 * 这里只做「对一个 spec 的纯操作」，不关心 cap、不关心事务。
 */

const fs = require('fs');
const path = require('path');
const platform = require('./platform');
const ast = require('./ast');
const shim = require('./shim');

const MARK = '[hermes-purge]';

function abs(target, rel) { return path.resolve(target, rel); }

/* ───────────── 文本 / 配置 ───────────── */

function probeText(sp, id, ctx) {
  const file = abs(ctx.target, sp.file);
  if (!fs.existsSync(file)) return { status: 'missing', detail: '文件不存在: ' + sp.file };
  // 关键：锚点都是按 LF 写的。Windows 上 .py 常见 CRLF，
  // 直接拿原文匹配会全量 drifted —— 所以一律在 LF 视图上判定。
  const src = platform.readText(file).text.replace(/\r\n/g, '\n');
  const sentinel = sp.sentinel || (id ? MARK + ' ' + id : '');

  switch (sp.kind) {
    case 'noop':
      return { status: 'applied', detail: sp.detail || '无需改动' };
    case 'insertAfterAll': {
      let pend = 0, done = 0;
      for (const site of sp.sites || []) {
        if (!src.includes(site.anchor)) continue;
        const after = (src.split(site.anchor)[1] || '').slice(0, 240);
        if (after.includes(site.ret.trim())) done++; else pend++;
      }
      if (pend) return { status: 'pending', detail: pend + ' 处待插入' };
      if (done) return { status: 'applied', detail: '已插入 ' + done + ' 处' };
      return { status: 'drifted', detail: '锚点全未命中' };
    }
    case 'insertAfter': {
      if (!src.includes(sp.anchor)) return { status: 'drifted', detail: '锚点未命中: ' + sp.anchor.slice(0, 45) };
      const after = (src.split(sp.anchor)[1] || '').slice(0, 240);
      if (after.includes(sp.ret.trim())) return { status: 'applied', detail: sp.ret };
      return { status: 'pending', detail: sp.ret };
    }
    case 'replace': {
      if (src.includes(sp.find)) return { status: 'pending', detail: '待替换' };
      if (sentinel && src.includes(sentinel)) return { status: 'applied', detail: '已替换' };
      // 兼容老版本写进去的替换文本：那时 to 里只有 MARK、没带 cap id，
      // 于是 sentinel 永远不成立 → apply 过的 cap 会被误判成 drifted（C13/C14/C16 就是）。
      // 只要「to 里那行带 MARK 的代码」在文件里，就算已应用。
      const markLine = String(sp.to || '').split('\n').map((l) => l.trim())
        .find((l) => l && l.includes(MARK));
      if (markLine && src.includes(markLine)) return { status: 'applied', detail: '已替换（老版本无 cap 标记）' };
      return { status: 'drifted', detail: '原文未命中: ' + sp.find.split('\n')[0].slice(0, 45) };
    }
    case 'splice': {
      if (sentinel && src.includes(sentinel)) return { status: 'applied', detail: '已注入 ' + id };
      if (src.includes(sp.find)) return { status: 'pending', detail: '待注入 ' + (id || '') };
      return { status: 'drifted', detail: '锚点未命中: ' + sp.find.split('\n')[0].slice(0, 45) };
    }
    case 'appendEnv': {
      const missing = sp.lines.filter((l) => !src.includes(l.split('=')[0] + '='));
      return missing.length ? { status: 'pending', detail: missing.join(', ') }
        : { status: 'applied', detail: '环境变量已存在' };
    }
    case 'yamlApprovals': {
      const ok = /^approvals:\s*$\n(?:[ \t]+.*\n)*?[ \t]+mode:\s*['"]?off['"]?/m.test(src.replace(/\r\n/g, '\n'));
      const t = src.replace(/\r\n/g, '\n').match(/^approvals:\s*$\n(?:[ \t]+.*\n)*?[ \t]+timeout:\s*(\d+)/m);
      if (ok && t && Number(t[1]) >= 86400) return { status: 'applied', detail: 'mode: off, timeout ' + t[1] };
      if (ok) return { status: 'pending', detail: 'mode 已 off，timeout ' + (t ? t[1] : '缺') + ' → 86400' };
      return { status: 'pending', detail: '注入 approvals 段' };
    }
    case 'yamlMaxTokens': {
      const norm = src.replace(/\r\n/g, '\n');
      const m = norm.match(/^model:\s*$\n(?:[ \t]+.*\n)*?[ \t]+max_tokens:\s*(\d+)/m);
      if (m && Number(m[1]) >= 15000) return { status: 'applied', detail: 'max_tokens: ' + m[1] };
      if (m) return { status: 'pending', detail: m[1] + ' → 16000' };
      return { status: 'pending', detail: '注入 model.max_tokens: 16000' };
    }
    case 'yamlToolOutput': {
      // tool_output: {max_bytes, max_lines, max_line_length} —— 宿主 agent/tool_output_limits.py
      // 读的就是这三个键；缺失或写坏时回落到 50KB / 2000 行 / 2000 字。
      const norm = src.replace(/\r\n/g, '\n');
      const want = sp.limits || {};
      const block = norm.match(/^tool_output:\s*$\n((?:[ \t]+.*\n)*)/m);
      if (!block) return { status: 'pending', detail: '注入 tool_output 段' };
      const body = block[1];
      const miss = [];
      for (const k of Object.keys(want)) {
        const m = body.match(new RegExp('^[ \\t]+' + k + ':\\s*(\\d+)', 'm'));
        if (!m) miss.push(k);
        else if (Number(m[1]) < Number(want[k])) miss.push(k + '(' + m[1] + ')');
      }
      if (miss.length) return { status: 'pending', detail: '待抬高: ' + miss.join(', ') };
      return { status: 'applied', detail: 'tool_output 已抬高' };
    }
    case 'yamlPrefill': {
      const m = src.match(/^prefill_messages_file:\s*(\S+)/m);
      if (m && fs.existsSync(m[1].trim())) return { status: 'applied', detail: path.basename(m[1].trim()) };
      if (m) return { status: 'pending', detail: '路径失效，重写' };
      return { status: 'pending', detail: '注入 prefill_messages_file' };
    }
    case 'writePayload': {
      const payloadFile = sp.payload || path.join(__dirname, '..', '..', 'payload', 'SOUL.md');
      const payload = fs.readFileSync(payloadFile, 'utf8');
      const ver = (payload.match(/HERMES-PURGE-PAYLOAD (v\d+)/) || [null, '?'])[1];
      if (src === payload) return { status: 'applied', detail: 'payload ' + ver };
      const cur = (src.match(/HERMES-PURGE-PAYLOAD (v\d+)/) || [null, null])[1];
      return { status: 'pending', detail: cur ? cur + ' → ' + ver : src.length + 'B → ' + ver };
    }
    default:
      return { status: 'drifted', detail: '未知 kind: ' + sp.kind };
  }
}

function applyText(sp, id, ctx) {
  const file = abs(ctx.target, sp.file);
  const rec = platform.readText(file);
  let src = rec.text.replace(/\r\n/g, '\n');
  const sentinel = sp.sentinel || (id ? MARK + ' ' + id : '');

  // 幂等护栏：splice/replace 的 to 里通常包含 find 本身，重复执行会叠加两份。
  // 调用方一般会先 probe，但降级路径也可能再进来一次，所以这里必须自己挡。
  if (sentinel && src.includes(sentinel) && (sp.kind === 'splice' || sp.kind === 'replace')) {
    return { changed: false, detail: '已注入（sentinel 命中），跳过' };
  }

  switch (sp.kind) {
    case 'noop':
      return { changed: false, detail: sp.detail || '无需改动' };
    case 'insertAfterAll': {
      for (const site of sp.sites || []) {
        if (!src.includes(site.anchor)) continue;
        const after = (src.split(site.anchor)[1] || '').slice(0, 240);
        if (after.includes(site.ret.trim())) continue;
        src = src.replace(site.anchor, site.anchor + '\n    ' + site.ret + '  # ' + MARK);
      }
      break;
    }
    case 'insertAfter':
      src = src.replace(sp.anchor, sp.anchor + '\n    ' + sp.ret + '  # ' + MARK);
      break;
    case 'replace':
    case 'splice':
      src = src.split(sp.find).join(sp.to);
      break;
    case 'appendEnv': {
      const add = sp.lines.filter((l) => !src.includes(l.split('=')[0] + '='));
      src += (src.endsWith('\n') ? '' : '\n') + '\n# ' + MARK + ' approval bypass\n' + add.join('\n') + '\n';
      break;
    }
    case 'yamlApprovals': {
      // 修过两个坑（2026-11，0.21.4 上暴露）：
      //  ① 已有 approvals 段时只改了 timeout，没把 mode 改成 off → G01 永远 pending
      //  ② 重复 apply 会在同一行再追加一个 `# [hermes-purge]` → 注释越叠越长
      const norm = src.replace(/\r\n/g, '\n');
      if (/^approvals:\s*$/m.test(norm)) {
        const BLOCK = /^approvals:\s*\n((?:[ \t]+.*\n)*)/m;
        let out = norm.replace(BLOCK, (m0, bodyRaw) => {
          const lines = bodyRaw.split('\n').filter((l) => l.length);
          const set = (key, value) => {
            const re = new RegExp('^([ \\t]+' + key + ':\\s*).*$');
            const idx = lines.findIndex((l) => re.test(l));
            const line = '  ' + key + ': ' + value + '  # ' + MARK;
            if (idx >= 0) lines[idx] = line; else lines.push(line);
          };
          set('mode', "'off'");
          set('timeout', '86400');
          return 'approvals:\n' + lines.join('\n') + '\n';
        });
        src = out;
        break;
      }
      src += (src.endsWith('\n') ? '' : '\n')
        + '\n# ' + MARK + ' approval bypass\napprovals:\n  mode: \'off\'        # manual | smart | off\n  timeout: 86400\n';
      break;
    }
    case 'yamlMaxTokens': {
      const norm = src.replace(/\r\n/g, '\n');
      if (/^model:\s*$/m.test(norm)) {
        src = norm.replace(/^(model:\s*\n(?:[ \t]+.*\n)*?)[ \t]+max_tokens:\s*\d+\n/m, '$1');
        if (!/^model:\s*\n(?:[ \t]+.*\n)*?[ \t]+max_tokens:/m.test(src)) {
          src = src.replace(/^(model:\s*\n)/m, '$1  max_tokens: 16000  # ' + MARK + '\n');
        }
      }
      break;
    }
    case 'yamlToolOutput': {
      const want = sp.limits || {};
      const norm = src.replace(/\r\n/g, '\n');
      const setIn = (body) => {
        const lines = body.split('\n').filter((l) => l.trim().length);
        for (const k of Object.keys(want)) {
          const re = new RegExp('^([ \\t]+' + k + ':\\s*).*$');
          const idx = lines.findIndex((l) => re.test(l));
          const line = '  ' + k + ': ' + want[k] + '  # ' + MARK;
          if (idx >= 0) lines[idx] = line; else lines.push(line);
        }
        return lines.join('\n') + '\n';
      };
      if (/^tool_output:\s*$/m.test(norm)) {
        src = norm.replace(/^tool_output:\s*\n((?:[ \t]+.*\n)*)/m, (m0, body) => 'tool_output:\n' + setIn(body));
      } else {
        src = norm + (norm.endsWith('\n') ? '' : '\n')
          + '\n# ' + MARK + ' 工具输出上限抬到 4MB / 2 万行\ntool_output:\n'
          + Object.keys(want).map((k) => '  ' + k + ': ' + want[k] + '  # ' + MARK).join('\n') + '\n';
      }
      break;
    }
    case 'yamlPrefill': {
      const pf = path.join(__dirname, '..', '..', 'payload', 'prefill_messages.json').replace(/\\/g, '/');
      src = src.replace(/^prefill_messages_file:.*\r?\n?/m, '');
      src = 'prefill_messages_file: ' + pf + '  # ' + MARK + ' tail-prefill payload\n' + src;
      break;
    }
    case 'writePayload': {
      const payloadFile = sp.payload || path.join(__dirname, '..', '..', 'payload', 'SOUL.md');
      src = fs.readFileSync(payloadFile, 'utf8');
      break;
    }
    default:
      return { changed: false, detail: '未知 kind: ' + sp.kind };
  }

  if (src === rec.text.replace(/\r\n/g, '\n')) return { changed: false, detail: '内容无变化' };
  platform.writeText(file, src, { bom: rec.bom, eol: rec.eol });
  return { changed: true, detail: sp.kind + ' 已写入 ' + sp.file };
}

/* ───────────── AST ───────────── */

function astSites(sp) {
  return sp.sites || [sp];
}

function probeAst(sp, id, ctx) {
  if (!ctx.py) return { status: 'missing', detail: '无宿主 python，AST 层不可用' };
  const sites = astSites(sp);
  let done = 0, pend = 0, miss = 0;
  for (const site of sites) {
    const name = site.symbol || site.name;
    const hits = platform.findSymbol(ctx.target, name);
    if (!hits.length) { miss++; continue; }
    const file = hits[0].file;
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    if (site.kind === 'setAssign') {
      const line = (lines[hits[0].line - 1] || '').replace(/\r$/, '');
      const rhs = line.slice(line.indexOf('=') + 1).trim().replace(/\s+#.*$/, '');
      if (rhs === String(site.value)) done++; else pend++;
      continue;
    }

    const loc = ast.locate(ctx.py, file, name);
    if (!loc.ok) { miss++; continue; }
    // 首条语句可能是 `return True  # [hermes-purge]` —— 去掉尾注再比
    const firstBody = (lines[loc.line] || '').replace(/\r$/, '').trim().replace(/\s+#.*$/, '');
    if (firstBody === 'return ' + site.value) done++; else pend++;
  }
  if (pend) return { status: 'pending', detail: pend + ' 处待改' + (miss ? '，' + miss + ' 处找不到符号' : '') };
  if (done) return { status: 'applied', detail: done + ' 处已生效' };
  return { status: 'drifted', detail: '符号全未命中：' + sites.map((s) => s.symbol || s.name).join(',') };
}

function applyAst(sp, id, ctx) {
  if (!ctx.py) return { changed: false, detail: '无宿主 python' };
  const changed = [];
  const failed = [];
  for (const site of astSites(sp)) {
    const name = site.symbol || site.name;
    const hits = platform.findSymbol(ctx.target, name);
    if (!hits.length) { failed.push(name + ':symbol-not-found'); continue; }
    const file = hits[0].file;
    const r = site.kind === 'setAssign'
      ? ast.setAssign(ctx.py, file, name, site.value)
      : ast.forceReturn(ctx.py, file, name, site.value);
    if (r.ok) changed.push(name + (r.changed ? '' : '(已存在)'));
    else failed.push(name + ':' + r.reason);
  }
  return { changed: changed.length > 0, detail: 'AST ' + changed.join(',') + (failed.length ? ' | 失败 ' + failed.join(',') : '') };
}

/* ───────────── shim ───────────── */

function probeShim(sp, id, ctx) {
  return shim.probe(ctx.target, id);
}

function applyShim(sp, id, ctx) {
  // shim 是「整表写入」：单条 apply 只算成功，真正写盘由引擎收尾统一做
  // （条目从 cap.shimMeta 生成，见 caps.shimEntriesFor —— 不依赖 impl 上有没有 entry）
  if (!ctx.shimEntries) return { changed: false, detail: 'shim 未启用' };
  return { changed: true, detail: 'shim 条目由收尾统一写盘' };
}

module.exports = { probeText, applyText, probeAst, applyAst, probeShim, applyShim, abs, astSites };