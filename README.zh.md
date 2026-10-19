# dsh-remote

[![CI](https://github.com/Golden-Pigeon/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/Golden-Pigeon/dsh-remote/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-remote-local-plugin.svg)](https://www.npmjs.com/package/dsh-remote-local-plugin)

[English](README.md) | 简体中文

把远端开发变成和本地 Session 一样的体验。

添加一次 SSH 主机后，插件会自动准备远端 DSH 运行时，把远端工作区和 Session 镜像到本地侧边栏，并在**普通 Conversation UI** 中打开远端 Session。转录、输入框、工具卡片、停止按钮和 Session 列表都与本地 Session 一致。

```text
本地 DSH                                        远端主机
┌──────────────────────────────────────┐          ┌──────────────────────────────┐
│ 普通侧边栏 + Conversation UI         │          │ dsh web（由插件安装）        │
│  本地镜像 Session + Agent façade     │  SSH     │ dsh-remote-agent             │
│  主机注册 / 自动安装                 │◀────────▶│  workspace/session 写入      │
│  直连 key 或本地 key proxy           │          │  远端工具 + 模型调用          │
│  已认证的 /api 路由                  │  隧道    │                              │
└──────────────────────────────────────┘          └──────────────────────────────┘
```

## 支持环境

本插件面向 **[官方 DSH Desktop 客户端](https://github.com/deepseek-ai/deepseek-harness)** 开发。目前唯一测试并声明支持的 DSH 版本是：

| 组件 | 测试版本 |
|---|---|
| [DSH Desktop / 官方客户端](https://github.com/deepseek-ai/deepseek-harness) | [**0.2.1-rc.2**](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) |
| 插件 | [**0.8.9**](https://www.npmjs.com/package/dsh-remote-local-plugin) |
| 远端 DSH 运行时 | [**0.2.1-rc.2**](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) |
| 远端 Node.js | [**22.19+**](https://nodejs.org/en/download) |
| 远端操作系统 | Linux 或 macOS |

没有测试过其他 DSH GUI 插件、社区 fork、修改过的客户端、非 DSH GUI 或其他 DSH 版本。包的依赖范围为了安装兼容性写得较宽，但不代表兼容性承诺或支持范围。使用本版本时请把 DSH 固定为 [`0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)。

## 已实现功能

| 能力 | 状态 |
|---|---|
| 插件页一键安装 | 可用 |
| 基于 SSH 的远端自动安装 | 可用 |
| 主机注册、发现、SSH 隧道、健康检查、重连 | 可用 |
| 远端工作区出现在本地工作区列表 | 可用 |
| 远端 Session 出现在普通侧边栏 | 可用 |
| 远端 Session 在普通 Conversation UI 中打开 | 可用 |
| UI 跟随 DSH 语言（中文 / 英文） | 可用 |
| Prompt、停止、转录、工具卡片、usage | 可用 |
| 默认远端直连 key，或可选的本地 key proxy | 可用 |
| 远端文件树和文件预览 | 可用（SSH） |
| 每个 Session 的远端终端 | 可用（本地 Session 用本地 PTY；远端 Session 用 SSH PTY） |
| 主机/工作区/Session 的 Agent 工具 | 可用 |
| 审批提示接入本地 UI | 可用 |
| Relay/NAT、云沙箱、多租户 | 尚未实现 |

## 安装

### 从 DSH 插件页安装

打开 **Plugins → Add plugin**，输入：

```text
dsh-remote-local-plugin
```

DSH 会从 npm 安装 bundle。这个包已经包含远端 agent 资源和 terminal-controller fork，不需要再安装其他包。按插件页提示重启 DSH，然后 **Settings → Remote development** 会出现。

### 从源码安装

开发时克隆仓库并运行安装脚本：

```sh
cd /path/to/dsh-remote/dsh-remote
pnpm install
pnpm -r build
./scripts/install-local.sh
```

脚本会构建 workspace，生成一个包含 terminal-controller fork 的单插件 tarball，并安装到 `desktop` profile。安装到 DSH Web profile：

```sh
./scripts/install-local.sh --profile web
# 重启使用该 profile 的 DSH Web 进程
```

重新打开 DSH 后出现 **Settings → Remote development**。

## 使用

1. 在 **Settings → Remote development** 输入 SSH 目标（例如 `my-host`），点击 **Save and connect**。
2. 首次连接时，插件会发现或安装远端 agent，启动远端 `dsh web`，建立 loopback 隧道，并把解析到的模型 key 写入远端环境。主机卡片会显示 **Installing → Connected** 和 **Model credentials: Remote direct**。
3. 在侧边栏 **Workspaces** 标题栏点击 **+**。新建工作区弹窗可以选择 **This computer** 或已连接的 **Remote device**，再点 **Add** 选择源目录。本机目录使用系统原生目录选择器；远端目录使用只读 SSH 浏览器。
4. 创建流程会创建远端 Session、在本地建立镜像，并在**普通 Conversation UI** 中打开。工作区行的 **New session** 使用同一个远端目录。
5. 在普通输入框中输入。远端 DSH 执行本轮任务，本地转录实时更新；工具调用、usage、停止和多轮 follow-up 都与本地 Session 一致。
6. **Workspace files** 和 **New terminal** 面板跟随当前 Session：本地 Session 使用本机，远端镜像 Session 使用远端工作区。

Settings 页面只负责主机和工作区管理，会话本身不是弹窗。

## 原生 Session 的实现方式

插件不嵌入第二套聊天 UI，也不 iframe 远端页面。它会：

1. 根据远端 Session 已提交的事件日志，在本地创建真实的 `Session`；
2. 为这个本地 Session 注册一个小型自定义 Agent façade；
3. 把本地的 `followup` / `steer` / `cancel` 路由到远端 agent API；
4. 跟随远端日志，把新提交的事件追加到本地 Session；
5. 让 DSH 现有的 Session Controller、侧边栏、Conversation assembler、输入框和工具渲染器像显示本地 Session 一样显示它。

远端 DSH 仍然是执行所有者；本地 Session 是持久、实时的镜像，普通客户端代码路径负责渲染、选择、流式更新和转录。

## 模型凭据

**默认：远端直连 key。** 插件从本地 DSH 凭据存储读取 `DEEPSEEK_API_KEY`，写入远端 `dsh web` 环境，并设置：

```text
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
```

远端 agent 直接调用 DeepSeek。

**可选：本地代理。** 设置 `credentialProxy: true` 可以把 key 留在本地：

- 远端 DSH 获得 `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` 和一个占位 key；
- SSH 隧道增加 `-R 127.0.0.1:47821:127.0.0.1:<local-proxy-port>`；
- 本地代理校验每个主机独立的 proxy token，注入真实 key，再转发到 `credentialProxyUpstream`。

如果本地没有可解析的 key，插件仍会安装并连接；此时需要配置远端 DSH 自己的凭据。主机卡片会显示 **Model credentials: Local proxy / Remote direct / Remote default**。

## Agent 工具

| 工具 | 用途 |
|---|---|
| `remote_hosts_list` | 主机、阶段、远端信息 |
| `remote_host_add` | 添加 SSH 主机并开始安装 |
| `remote_host_connect` | 连接/重连/刷新 |
| `remote_host_provision` | 强制重新安装/重启并重连 |
| `remote_workspace_add` | 注册远端目录 |
| `remote_workspaces_list` | 列出远端 workspace |
| `remote_session_create` | 创建远端 Session |
| `remote_sessions_list` | 列出远端 Session |
| `remote_session_prompt` | 发送 prompt |
| `remote_session_snapshot` | 读取一页转录 |
| `remote_session_cancel` | 取消当前 turn |

主机写操作（`remote_host_add`、`remote_host_connect`、`remote_host_provision`）会走 DSH approval UI；`remote_host_add` 默认不自动连接。

## 环境要求

**本地：** 官方 [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness)，或同核心版本的 DSH Web；需要可通过 key 或 ssh-agent 免交互认证的 `ssh`。只有官方 Desktop 客户端是经过验证的 GUI 目标。

**远端：** Linux 或 macOS，带 SSH server。优先使用 [Node.js 22.19+](https://nodejs.org/en/download)，会从 PATH、nvm、Volta、fnm、Bun、asdf、mise、Nix、Homebrew 和登录 shell 中查找。找不到可用 Node.js 时，安装器会把官方 Node.js tarball 下载到 `remoteInstallDir`，校验 SHA-256 后解压使用，不需要 root。

自动安装 Node.js 需要远端有 `curl` 或 `wget`、`tar`，以及 `sha256sum` 或 `shasum`。不支持 Windows 远端。

如果远端需要代理，把 `remoteInstallProxy` 设为**从远端能访问的**代理 URL，例如端口转发后暴露在远端的 `http://127.0.0.1:17890`。安装流程会为 bootstrap 导出 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `npm_config_*`。留空时会使用该账号真实的登录 shell（bash、zsh、fish 等）及其登录/交互启动文件读取 `HTTPS_PROXY` / `HTTP_PROXY`。同一个代理也会写入远端 systemd unit（或由 `nohup` 进程继承），因此远端模型请求也会走代理，而不只是安装阶段。

## 安全

- SSH 是传输层；隧道只绑定 `127.0.0.1`。
- 主机 key 默认 TOFU（`accept-new`）；严格校验时使用 `yes` 并准备 `known_hosts`。
- 远端 agent 只监听 loopback，并使用 bearer token。它的写能力限制在 workspace/session 创建、prompt 和 cancel。prompt 可以让远端 DSH 在远端 sandbox 和审批策略下使用它自己的工具。
- 默认直连模式下，模型 key 会写入远端 systemd/nohup 环境。只应在可信远端账号上使用；systemd unit 以 `0600` 写入。设置 `credentialProxy: true` 可把 key 留在本地，并通过反向 SSH 隧道代理模型请求。代理请求需要每个主机独立的 token，远端无关本地用户不能复用该凭据端点。
- 浏览器请求走 DSH Connection 的已认证 `/api` Fetch 路由。token/凭据保存在 `0600` 文件中，永远不会返回浏览器。
- 文件树、预览、终端流量都在已认证的 SSH 隧道内。
- 只连接可信远端账号；远端 DSH 拥有该账号的权限。

## 配置

```yaml
- id: dsh-remote-local
  config:
    autoProvision: true
    remoteDshHome: ~/.dsh
    remoteInstallDir: ~/.local/share/dsh-remote
    remoteDshVersion: 0.2.1-rc.2
    remotePnpmVersion: 11.21.0
    remoteNodeVersion: 22.19.0
    # 远端可访问的代理；留空则读取远端登录 shell 的环境变量
    remoteInstallProxy: ''
    remoteInstallNoProxy: 127.0.0.1,localhost
    autoInstallNode: true
    remoteStart: systemd          # systemd | nohup | none
    credentialProxy: false
    copyModelKey: true
    remoteModelBaseUrl: https://api.deepseek.com/anthropic

    # 可选：本地代理模式
    credentialProxyUpstream: https://api.deepseek.com/anthropic
    credentialProxyRemotePort: 47821
    modelCredentialRef: DEEPSEEK_API_KEY

    mirrorSessions: true
    mirrorPollMs: 1500
    mirrorMaxEvents: 2000
```

远端 agent 还支持高级配置：

```yaml
- id: dsh-remote-agent
  config:
    stateFile: ''
    token: ''
    loopbackOnly: true
    defaultSnapshotEvents: 500
    maxSnapshotEvents: 2000
    heartbeatMs: 15000
```

## 已知限制

- 默认不提供完整的远端 DSH 浏览器 UI。远端会关闭 Remote-Event carrier，让审批 waterfall 到达本地原生 UI；这是让普通会话中的 **Allow once / Reject** 可用的取舍。
- 本地 workspace anchor 只是元数据句柄。文件列表、预览和终端会路由到远端；远端 diff 和部分高级文件操作仍使用原生 Session 的工具结果。
- 超过 `mirrorMaxEvents` 的远端 Session 不会镜像；可以调大限制，或直接在远端打开。
- 不支持 Windows 远端，也不支持 relay/NAT 穿透。

## 故障排查

| 现象 | 处理 |
|---|---|
| **Installing** 一直不结束 / `Waiting for remote dsh web…` | 检查 `ssh -o BatchMode=yes my-host true`；安装器会查找 nvm/Volta/fnm，并在需要时自动下载 Node.js。如果主机无法访问 nodejs.org 或缺少校验工具，手动安装 [Node.js 22.19+](https://nodejs.org/en/download)，或使用 `remoteStart: nohup`，然后点 **Reinstall** |
| `does not accept POST` | 远端 agent 太旧；点 **Reinstall** |
| 侧边栏没有远端 workspace | 用 **Workspaces +** 创建，或到 Settings → Remote development → Workspaces 查看 |
| 原生 Session 没有回复 | 检查 **Model credentials**；配置远端凭据 |
| `DeepSeek Messages request failed (404)` | Proxy upstream 必须是 `https://api.deepseek.com/anthropic`；重新安装插件并重连 |
| 本地出现审批，但远端工具仍失败 | 本地决定已经发出；检查远端工具结果 |
| 本地终端打开本地 shell | 本地 Session 的预期行为；远端 Session 使用 `Remote · <dir>` 终端 |
| 远端终端打开本地 zsh | terminal-controller fork 未生效；重新运行 `./scripts/install-local.sh` |
| 远端重启后端口变化 | 点 **Rediscover** |

远端日志：

```sh
journalctl --user -u dsh-remote-agent -f
# 或
$DSH_HOME/remote-agent/web.log
```

## 验证

```sh
pnpm verify
```

测试覆盖 protocol/SSE/cursor/write 契约、安装器渲染、proxy 转发和 client bundle。原生路径已在一个真实 Linux 远端主机上验证：插件安装、远端 workspace/session 创建、通过本地 key proxy 发送 prompt、实时事件镜像、第二轮 follow-up，以及远端工具调用/结果。

## 文档

- [Wire protocol](docs/protocol.md)
- [Operations guide](docs/operations.md)
- [ADR-001](docs/decisions/ADR-001-protocol-envelope.md)
- [Design document copy](docs/remote-development-design.md)
- [Testing](docs/testing.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## 包结构

| 包 | 作用 |
|---|---|
| [`@dsh-remote/protocol`](packages/protocol) | Wire 类型、surface metadata、cursor、SSE、typed client |
| [`dsh-remote-local-plugin`](packages/local-plugin) | 自动安装、隧道、proxy、**原生 Session 镜像**、工具、Settings |
| [`dsh-remote-agent`](packages/remote-agent) | 远端 DSH 插件：workspace、session、prompt、SSE |
| [`dsh-remote-terminal-controller`](packages/terminal-controller) | 按 Session 路由本地/远端终端的 profile fork |
| [`@dsh-remote/installer`](packages/installer) | 插件使用的 bootstrap 库/CLI |
| [`@dsh-remote/testkit`](packages/testkit) | Fake host 和 wire 契约测试 |

## License

MIT。见 [LICENSE](LICENSE)。
