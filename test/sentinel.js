'use strict';
/**
 * test/sentinel.js —— sentinel 自洽性（防止「改成功却报 drifted」这类回归）
 *
 * 文本层判定 = 文件里有没有 sentinel：
 *   默认 sentinel 是 `[hermes-purge] <cap id>`，也可以由 patch 显式指定。
 * 要求：每条 replace/splice 规格的 **替换文本里必须真的含有它自己的 sentinel**，
 * 否则 apply 成功了 status 也说 drifted（0.21.4 上就是这样暴露的）。
 *
 * 两个容易踩的坑，这里都盯住：
 *   ① 主锚注释没写 cap id，又没给显式 sentinel
 *   ② 变体继承了主锚的 sentinel，但变体的替换文本里是 `[hermes-purge] C16 …`（多了 id）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { buildCaps } = require('../lib/v2/caps');
const { MARK } = require('../lib/patches');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-sent-'));
fs.mkdirSync(path.join(tmp, 'agent'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'hermes_cli'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.yaml'), 'model:\n  default: x\n');

const caps = buildCaps({ target: tmp });
const targets = ['replace', 'splice'];

function specsOf(cap) {
  const out = [];
  for (const impl of cap.impls || []) {
    if (impl.kind === 'text' && impl.spec && targets.includes(impl.spec.kind)) {
      out.push({ label: cap.id + '/primary', spec: impl.spec, cap });
    }
  }
  for (const v of cap.variants || []) {
    const sp = v.spec || v;
    if (sp && targets.includes(sp.kind)) out.push({ label: cap.id + '/' + (v.label || v.kind || 'variant'), spec: sp, cap });
  }
  return out;
}

console.log('\nsentinel 自洽性');

t('每条 replace/splice 的替换文本里都含有它自己的 sentinel', () => {
  const bad = [];
  for (const cap of caps) {
    for (const { label, spec } of specsOf(cap)) {
      const sent = spec.sentinel || (MARK + ' ' + cap.id);
      const text = String(spec.to || '') + String(spec.ret || '');
      if (!text.includes(sent)) bad.push(label + ' → ' + JSON.stringify(sent).slice(0, 70));
    }
  }
  assert.deepStrictEqual(bad, [], '这些规格改完会被判成 drifted：\n    ' + bad.join('\n    '));
});

t('变体的 sentinel 不等于主锚的（除非变体文本确实含主锚 sentinel）', () => {
  const bad = [];
  for (const cap of caps) {
    const primary = (cap.impls || []).find((i) => i.kind === 'text' && i.spec && targets.includes(i.spec.kind));
    const pSent = primary && primary.spec.sentinel;
    if (!pSent) continue;
    for (const v of cap.variants || []) {
      const sp = v.spec || v;
      if (!sp || !targets.includes(sp.kind)) continue;
      const own = sp.sentinel || (MARK + ' ' + cap.id);
      const text = String(sp.to || '');
      if (!text.includes(own)) bad.push(cap.id + ' 变体继承了不该继承的 sentinel');
    }
  }
  assert.deepStrictEqual(bad, [], bad.join('; '));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
