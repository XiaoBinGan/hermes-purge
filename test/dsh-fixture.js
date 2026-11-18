'use strict';
/**
 * test/dsh-fixture.js —— 造一棵假的 DSH 0.2 树（**不进仓库**，只在临时目录）
 *
 * 布局照 dsh-purge README 里描述的 $DSH_HOME：
 *   cordis.yml / cordis.patch.yml        宿主 patch 层（插件配置写在这里）
 *   package.json                         name 含 dsh（adapter 探测用）
 *   plugins/dsh-purge/…                  插件本体（cap 的 text/conf 层落点）
 *   profiles/{web,desktop}/…             两个 profile（各自的 package.json + patch 层）
 *   config/{settings,approval,policy}.yaml + launch-env.json
 *
 * 有人会问「为什么不照真机抄」：本机没有 DSH 安装，这里按公开布局造结构，
 * 用来验证 engine ↔ adapter 的接口、conf/text/shim 三种落盘与回滚，不验证真机行为。
 */

const fs = require('fs');
const path = require('path');

const ROOT_PRESET = '/tmp/dsh-fixture';

function w(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

const FILES = {
  'package.json': JSON.stringify({
    name: 'dsh-fixture-home',
    private: true,
    dsh: { version: '0.2.0-rc.2', home: true },
  }, null, 2) + '\n',

  'cordis.yml': '[]\n',

  'cordis.patch.yml': `# 夹具：插件与全局 patch 层（扁平条目列表）
- id: dsh-purge
  name: dsh-purge
  config:
    enabled: true
    postPromptOrder: 5100
    postPrompt: ''
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    preset: default
`,

  'plugins/dsh-purge/package.json': JSON.stringify({
    name: 'dsh-purge',
    version: '1.7.20',
    main: 'index.js',
    dsh: { plugin: true, api: 2 },
  }, null, 2) + '\n',

  'plugins/dsh-purge/index.js': `'use strict';
// 夹具：插件入口（cap 只碰 lib/ 下的实现文件）
const hooks = require('./lib/hooks');

module.exports = {
  name: 'dsh-purge',
  apply(ctx) {
    void ctx;
    void hooks;
  },
};
`,

  'plugins/dsh-purge/lib/hooks.js': `'use strict';
// 夹具：钩子开关（每条 cap 的 text 层落点，锚点互不重叠）

const APPROVAL_HOOK = 'ask';
const SESSION_BYPASS = 'off';
const EDIT_CONFIRM = 'ask';
const DANGER_DETECT = 'on';
const ASK_USER = 'prompt';
const LOOP_GUARD = 'halt';
const TOOL_WHITELIST = 'strict';
const REPEAT_REMINDER = 'off';  // [hermes-purge] D13
const PLAN_GATE = 'on';
const SANDBOX_POLICY = 'strict';
const FS_OBSERVE = 'strict';
const BASH_TIMEOUT = 60000;
const MAX_OUTPUT = 640000;
const POST_PROMPT = '';

module.exports = {
  APPROVAL_HOOK, SESSION_BYPASS, EDIT_CONFIRM, DANGER_DETECT, ASK_USER,
  LOOP_GUARD, TOOL_WHITELIST, REPEAT_REMINDER, PLAN_GATE, SANDBOX_POLICY,
  FS_OBSERVE, BASH_TIMEOUT, MAX_OUTPUT, POST_PROMPT,
};
`,

  'plugins/dsh-purge/lib/regex.js': String.raw`'use strict';
// 夹具：危险命令正则表
const HARDLINE_PATTERNS = [/rm -rf \//i, /mkfs/i, /dd if=/i];
const DANGER_PATTERNS = [/sudo /i, /curl .*\|.*sh/i];

module.exports = { HARDLINE_PATTERNS, DANGER_PATTERNS };
`,

  'plugins/dsh-purge/lib/prompt.js': `'use strict';
// 夹具：系统提示词组装位
const SEGMENTS = ['identity', 'policy', 'workspace', 'skills'];

function buildSystemPrompt(parts) {
  return [SEGMENTS, parts].flat().filter(Boolean).join('\\n\\n');
}

module.exports = { buildSystemPrompt, SEGMENTS };
`,

  'plugins/dsh-purge/lib/instructions.js': `'use strict';
// 夹具：附加指令段（AGENTS.md 风格）
const EXTRA = [];

function buildInstructions() {
  return EXTRA.join('\\n');
}

module.exports = { buildInstructions, EXTRA };
`,

  'profiles/web/package.json': JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-purge': 'file:../../plugins/dsh-purge' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'restart' } },
  }, null, 2) + '\n',

  'profiles/desktop/package.json': JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-purge': 'file:../../plugins/dsh-purge' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'restart' } },
  }, null, 2) + '\n',

  // web 覆盖层：开局就带着 3 条已应用条目 → status 里 D01 / D25 / D30 = applied
  'profiles/web/cordis.patch.yml': `# 夹具：web profile 覆盖层（已有部分条目）
- id: permission-presets
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    approvalMode: 'off'
  # [hermes-purge] D01
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
  # [hermes-purge] D30
- id: skill-badge
  name: '@deepseek-ai/dsh-skill-badge'
  config:
    enabled: false
  # [hermes-purge] D25
`,

  // desktop 覆盖层：与 web 同三条已应用条目（cap 用 files:[web,desktop] 同构写两份）
  'profiles/desktop/cordis.patch.yml': `# 夹具：desktop profile 覆盖层
- id: permission-presets
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    approvalMode: 'off'
  # [hermes-purge] D01
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
  # [hermes-purge] D30
- id: skill-badge
  name: '@deepseek-ai/dsh-skill-badge'
  config:
    enabled: false
  # [hermes-purge] D25
`,

  'config/settings.yaml': `# 夹具：模型 / 采样
model: deepseek-flash
temperature: 0.2
max_tokens: 4096
`,

  'config/approval.yaml': `# 夹具：审批策略
mode: manual
timeout: 86400
`,

  'config/policy.yaml': `# 夹具：护栏策略
workspacePolicy: strict
toolWhitelist: default
haltOnLoop: true
`,

  'config/launch-env.json': JSON.stringify({ DSH_PROFILE: 'web', NODE_OPTIONS: '' }, null, 2) + '\n',
};

/** 造树（先清空），返回根目录 */
function build(root) {
  const dir = root || ROOT_PRESET;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of Object.keys(FILES)) w(dir, rel, FILES[rel]);
  return dir;
}

/** 递归列出文件（相对路径，跳过 purge 自己的状态目录与临时文件） */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (rel === '.hermes-purge' || ent.name === 'node_modules' || ent.name === '.git') continue;
        walk(abs);
      } else if (ent.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

module.exports = { build, listFiles, FILES, ROOT_PRESET };