# Windows 真机验证（可复现）

在一台 Windows 上验证两件事，各自一条命令：

```powershell
# 1) 工具链 + 安装/卸载 + 打包（不需要 Hermes，只需要 Node ≥18）
.\windows-smoke.ps1

# 2) 补丁引擎本身：真实源码文件 → apply → verify L1 → revert 逐字节还原
.\test\win\run-engine.ps1
```

## 2026-11-24 实测记录（lane/win，Windows 11 真机）

| 项 | 环境 | 结果 |
|---|---|---|
| 单元测试 | Win11 · Node v25.0.0 · Python 3.12（mambaforge）· PS 5.1 · Git Bash | smoke 41/41 · v2 33/33 · dsh 33/33 · setup 15/15 · bench 16/16 · plugin 10/10 · control 7/7 · desktop 12/12 · **desktop-dom 全部通过** · package 16/16 |
| `windows-smoke.ps1` | 同上 | `SMOKE_EXIT=0`，8 步全 OK，含「中文 + 空格路径安装 → purge --version = 3.1.4」 |
| `test/win/run-engine.ps1` | 同上 | `ENGINE_OK`：apply 退出 0 · C01/C07/C09 落地 · verify L1 通过 · revert 后三个文件 SHA256 与原件一致 |
| 真实 Hermes 安装 | `G:\hermes\hermes-agent` | `purge status` 31/31 applied · `verify --level=2` 通过 · `doctor` 健康（shim 22 条「宿主无此属性」单列跳过，不计失败） |

同一轮修掉的 Windows-only 问题（都在真实机器上复现过）：

- `install.sh` 在 Git Bash 里 `ln -s` 退化成「复制」→ `~/.hermes-purge` 是旧副本；现在用 `mklink /J` 目录联接，`--relink` 可重建
- `.cmd` 里写中文路径被 ASCII 编码毁成 `G:\????` → 改成 `%~dp0` 启动器 + UTF-8 路径文件
- AST 层 `bad-helper-output`（`.bat` 代理 spawn EINVAL / cp936 乱码）→ `spawnAny` + `PYTHONUTF8`
- `desktop-dom` 写死 `/Users/supre/...` 的 jsdom → 改成按候选列表找（本仓 devDep 也行），Windows 上终于不是「跳过」
- `test/win/run-engine.ps1` 与 `run-smoke.ps1` 写死 `C:\purge-test` → 改成自建临时树/相对路径，任何 Windows 机器可跑
- `.ps1` 缺 UTF-8 BOM → 新增 `test/setup.js` 守卫：仓库里每个 `.ps1` 必须带 BOM

## 2026-11-23 实测记录

| 项 | 环境 | 结果 |
|---|---|---|
| 工具链全量 | Win11 ARM 26H1 build 26300 · Node v22.11.0 · Python 3.12.8（embeddable） · VirtualBox 7.2.22 | `SMOKE_EXIT=0`：smoke 41/41 · v2 30/30 · dsh 33/33 · setup 12/12 · bench 16/16 · package 16/16（**无跳过**） |
| 补丁引擎 | 同上，`tools/approval.py`（5971 行）+ `agent/tool_guardrails.py` + `acp_adapter/edit_approval.py` 取自 `git show HEAD:` 的 pristine 版本 | `apply` 改写 17 · `verify --level=1` 4 项通过 · `revert` 后三个文件 **SHA256 全部与原件一致** |

### 只有真机会暴露、已修的问题

1. `.ps1` 缺 UTF-8 BOM → PS 5.1 按 ANSI 读中文注释，把后文吃进字符串（同一天遇到两次）
2. PS 5.1 会吃掉传给原生程序的参数里的双引号 → `node -p '…split(".")[0]'` 变成 `split(.)[0]`
3. `node … | Select-Object -First N` 提前关管道 → `$LASTEXITCODE` 变 `-1`
4. NTFS mtime 粒度粗 → 「同长度改写」用 size/mtime 检测不到（改为小文件算 sha256）
5. `python -S -c` 在 Windows 上不保证把 cwd 放进 `sys.path` → 埋点驱动找不到 `agent` 包

### 仍未验证

- Windows **x64**（只在 ARM64 上跑过）
- Windows 上的**真实 Hermes 安装**（guest 无网络，装不了依赖；补丁引擎是用真实源码文件验证的，不是完整 Hermes）
- DSH 宿主（只有夹具）