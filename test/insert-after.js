'use strict';
/**
 * test/insert-after.js —— ins()（insertAfter）的判活必须够严
 *
 * 老判定：锚点之后 240 字符内出现同名的 `return X` 就算 applied。
 * 问题：函数体本来就可能以同样的 return 开头 → 没打补丁也报 applied。
 * 实测在 0.21.5 上 C37 就是这样被漏掉的（status 说已生效，文件里却没有 marker）。
 *
 * 新判定：必须看到「锚点 + 我们插进去那句 + "  # [hermes-purge]"」。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const impls = require('../lib/v2/impls');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  \u2714 ' + n); } catch (e) { fail++; console.log('  \u2716 ' + n + '  \u2192 ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ins-'));
const file = path.join(tmp, 'guard.py');
const spec = {
  file: 'guard.py',
  kind: 'insertAfter',
  anchor: 'def check(path: str) -> str | None:',
  ret: 'return None',
};

console.log('\ninsertAfter 判活');

t('函数体本来就以同样的 return 开头 → 不能算 applied', () => {
  fs.writeFileSync(file, 'def check(path: str) -> str | None:\n    return None\n');
  const r = impls.probeText(spec, 'X1', { target: tmp });
  assert.strictEqual(r.status, 'pending', '误判成 ' + r.status + '（应 pending，等 apply 插 marker）');
});

t('插过（带 marker）→ applied', () => {
  fs.writeFileSync(file, 'def check(path: str) -> str | None:\n    return None  # [hermes-purge]\n    return None\n');
  const r = impls.probeText(spec, 'X1', { target: tmp });
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
});

t('apply 之后确实是 applied，且文件里多了 marker', () => {
  fs.writeFileSync(file, 'def check(path: str) -> str | None:\n    return None\n');
  const a = impls.applyText(spec, 'X1', { target: tmp });
  assert.ok(a.changed, JSON.stringify(a));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('# [hermes-purge]'), '没有 marker：' + after);
  const r = impls.probeText(spec, 'X1', { target: tmp });
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
});

t('锚点不存在 → drifted（不是 pending）', () => {
  fs.writeFileSync(file, 'def other():\n    return None\n');
  const r = impls.probeText(spec, 'X1', { target: tmp });
  assert.strictEqual(r.status, 'drifted', JSON.stringify(r));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? `全部通过 ${pass}/${pass}` : `${pass} 通过 · ${fail} 失败`));
process.exit(fail === 0 ? 0 : 1);
