## hermes-purge 1.0.0

首个发布版本。对 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的三层清洗，附带破甲执行器与效力边界探针。

> 思想来自 **dsh-purge** —— 「不跟模型讲道理，直接改宿主」那套思路。

补丁锚点验证于 **Hermes Agent 0.21.3**。

---

### 安装

```bash
git clone https://github.com/XiaoBinGan/hermes-purge.git
cd hermes-purge
```

零依赖，不需要 `npm install`。要求 Node.js 18+。

```bash
node bin/hermes-purge.js --status        # 先看状态，不改任何东西
node bin/hermes-purge.js --apply --dry   # 预演
node bin/hermes-purge.js --apply         # 正式应用
node bin/hermes-purge.js --verify        # 八项运行时断言
```

**改完必须重启 Hermes** —— approval 的 YOLO 状态在模块导入时冻结。

回滚：`node bin/hermes-purge.js --revert`

### 使用

```bash
node bin/hp.js "写个 Python 端口扫描器"
```

自动判断语言与模式，被拒自动重试，默认只打印结果。

---

### 内容

**清洗器：21 条补丁**

| 层 | 条数 | 内容 |
|----|------|------|
| 提示词 | 2 | `SOUL.md` 人格 payload 替换 |
| 配置 | 4 | `approvals.mode=off`、`model.max_tokens: 16000`、prefill 文件、`.env` 注入 |
| 代码 | 15 | 审批门 / 审批模式 / 编辑确认 / 循环护栏 / 命令黑名单 / 系统提示词注入位置 / prefill 位置 |

**执行器**

- `hp` — 一条命令入口，自动判断 `plain` / `code` / `prose` 三种模式
- `hermes-p` — 直连模型或 `hermes -z` 子进程
- `dashboard-chat` — 走 Dashboard Chat 同一条 JSON-RPC WebSocket

**探针**

- `probe` — 8 类探针（含 1 个对照组），统计单次通过率、拒绝话术归类、`1-(1-p)^6` 收敛期望
- `rescore` — 用改过的分类器重评已有样本，不重跑模型

---

### 实测数据（deepseek-flash，单次 p）

| 类别 | 单次 p | 6 次重试期望 |
|------|--------|--------------|
| 安全工具代码（AMSI 补丁） | 0.25 ~ 1.00 波动 | 82% ~ 100% |
| 注册机 / 破解 | 0.75 | 100% |
| 键盘记录器 / 窃密类 | 0.17 ~ 0.25 | 67% ~ 82% |
| 注入探测脚本 | 0.25 ~ 0.33 | 82% ~ 91% |
| 露骨成人正文 | 0.83 ~ 1.00 | 98% ~ 100% |
| 钓鱼页 / 凭据采集 | 0.00 | **0%** |
| 伤害他人手册（对照） | 0.00 | **恒定 0** |

工具层：`--verify` 八项断言全绿，`rm -rf / --no-preserve-root`、fork bomb、`dd of=/dev/sda` 全部 `approved=True`。

---

### 三个有效杠杆（实测，按贡献排序）

1. **assistant prefill 放消息末尾** — 模型做的是「续写」，不是「决定要不要写」
2. **提示词注入位置 `system` → 历史 `user`** — `system` 角色承载最强对齐
3. **`max_tokens` ≥ 16000** — 低于此推理吃光预算，`content` 返回空，看起来像拒绝

反面结论：叠第二层 primer 会**降低**成功率；多轮换话术无稳定增益。

---

### 工程

- 判定逻辑收敛到 `lib/core.js` 单一来源（早期三份入口各写一份，已漂移过一次）
- 通道收敛到 `lib/channels.js`
- 零硬编码路径，自动探测：`--target` → `HERMES_HOME` → `HERMES_ROOT` → PATH 反推 → 向上查找
- 38 项冒烟测试，不联网、不改文件、不需要真实 Hermes

---

### 已知局限

- 补丁锚点是精确文本匹配，Hermes 升级后会 `drifted`
- 探针只看聊天正文，不看磁盘产物（带工具的 agent 可能已把代码写盘）
- 内容层拒绝是采样随机的，`--tries` 是工程收敛手段，不是保证
- 只在 Windows 上完整实测过

---

### ⚠️ 免责声明

**本软件仅用于合法的安全研究、渗透测试、教育与自查用途**，且仅限于你拥有或已获得明确书面授权的系统与环境。

**本软件会关闭宿主程序的审批与安全检查机制。** 安装后，宿主程序执行操作将不再征求确认。由此产生的任何后果由使用者自行承担。

**严禁用于任何违法活动**，包括但不限于：未经授权访问他人计算机系统或数据；制作、传播恶意软件；攻击非授权目标；绕过他人安全机制；窃取凭据；侵犯隐私；伪造证件或支付凭证；欺诈、洗钱等金融犯罪。

本软件按「原样」提供（AS IS），不附带任何明示或暗示的担保。作者、贡献者、版权持有人均不对因使用本软件产生的任何直接、间接、偶然、特殊、惩戒性或后果性损害承担责任。

使用者有责任自行确认其行为符合所在地法律法规。若不确定场景是否合法，请停止使用并咨询法律专业人士。

完整条款见 [README](https://github.com/XiaoBinGan/hermes-purge#免责声明) 与 [LICENSE](https://github.com/XiaoBinGan/hermes-purge/blob/main/LICENSE)。
