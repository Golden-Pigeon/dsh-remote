> **Historical note:** this document describes an early two-repository plan. The proposed
> `dsh-remote-client` patch/fork repository was built as a prototype and has been removed; it was
> never part of the runtime or user installation. The shipped implementation is the single
> `dsh-remote` repository: `local-plugin` + `terminal-controller` + `remote-agent` + `installer`.
> References to `dsh-remote-client` below are retained only as design history.

> **Implementation note:** this is an early design note. The implemented plugin now mirrors remote
> sessions into the native conversation UI, bridges approvals/files/terminal traffic, and defaults to a
> direct model key in the remote service environment (`credentialProxy: true` keeps it local). See the
> root README and `docs/operations.md` for the current behavior.
>
> This is a repository copy of `../../docs/remote-development-design.md` from the umbrella
> workspace, kept with the implementation so the design intent travels with the code. The
> `remote-dev-kit/` references in the original are not part of this repository.

# DSH 远程开发设计文档：从 A 到 B-native

- **Status**: Draft v0.1
- **Date**: 2026-10-18
- **Context**: DSH Desktop `0.2.1-rc.2` / macOS；目标是在另一个 project 中实现
- **Goal**: 做出 Codex / ZCode 那种远程开发体验：点开工程、点开会话、直接对话；远程 session 可持久、可重连、多 host

---

## 0. 决策摘要

1. **Codex / ZCode 的远程模式都是 B**：远端持有 session，本地只是客户端。两家都不是“只做 B”，而是同时支持 L（纯本地）和 B（远程）。
2. **DSH 目前没有 B-native**：客户端按单 Host 组装。现有插件只能做到：
   - A：`dsh-remote-development`，UI 100% 一样，但 session 在本地；
   - B-lite：`dsh-remote-tunnel` / `dsh-remote-explorer`，remote session 能跑，但 UI 是侧栏/标签页里的远端界面，不是本地 workspace 列表。
3. **目标架构选 B-native**：host-aware 客户端 + 远端 runtime + 远端 agent。A 保留为 DSH 现有的“本地 session + 远端执行”快速路径，B-lite 作为过渡，纯本地/离线仍走本地模式。
4. **仓库：2 个起步，3 个完整，4 个含云。**
   - 今天：`dsh-remote`（协议 + 本地插件 + 远端 agent + installer）、`dsh-remote-client`（host-aware 客户端 patch/fork）
   - 需要 NAT/云时：`dsh-remote-relay`
   - 做云沙箱/PR/多租户时：`dsh-remote-cloud`
5. **当前非目标**：Codex Cloud 式沙箱编排、PR、多租户、计费。

---

## 1. 背景与目标

### 1.1 背景

DSH（DeepSeek Harness）是插件化的 agent harness。DSH Desktop 目前是单 Host 客户端：

- 本地 DSH 进程同时承担 Host 和 Client；
- 会话、工作区、文件、终端、审批都在本地进程里；
- 插件可以替换 `fs` / `subprocess` / `bash` / `search` provider，但不能改变“客户端只连一个 Host”的基本假设。

用户要的不是“SSH 转发工具调用”，而是 Codex / ZCode 那种体验：

- 点开远程工程；
- 点开会话；
- 直接对话；
- 关掉本地客户端后，任务仍在远端继续；
- 多 host 切换；
- 文件、终端、diff、审批都在同一个界面里。

### 1.2 目标

- **UX**：远程 workspace 与本地 workspace 出现在同一个列表；远程 session 在同一个主区域打开；不使用 iframe 作为最终形态。
- **Session 归属**：session、agent loop、工具执行、终端、文件都在远端 runtime；本地只做 UI 和连接。
- **连接**：先 SSH（零入站端口、复用现有认证），后续支持 outbound WebSocket relay。
- **凭据**：默认把解析到的模型 key 写入远端 service 环境；可选本地代理模式，通过反向隧道注入，远端只拿占位 token。
- **多 host**：一个客户端管理多台机器；每个 workspace/session 有明确的 host 归属。
- **可恢复**：断线重连、attach/resume、审批不丢、终端可重连。

### 1.3 非目标（当前阶段）

- 云沙箱编排（VM/容器池、快照、预热）；
- PR 创建/评审流水线；
- 多租户、配额、计费；
- Windows 远端（可作为后续目标）；
- 自研 agent loop 或模型协议。

---

## 2. 术语

| 术语 | 含义 | 典型实现 |
|---|---|---|
| **L** | 本地 session + 本地执行；没有远端 | Codex Local/Worktree、ZCode 本地 workspace |
| **A** | 本地 session + 远端执行。session/agent 在本地，`fs`/`shell`/`search` 路由到远端 | `dsh-remote-development` |
| **B** | 远端 session + 本地 UI。session/agent 在远端，客户端 attach | Codex Cloud、ZCode Remote |
| **B-lite** | 远端完整 DSH Web UI 通过隧道/iframe/侧栏嵌入本地 | `dsh-remote-tunnel`、`dsh-remote-explorer`、`dsh-ssh-workspace` |
| **B-native** | 本地客户端原生渲染远端 session，workspace/session 与本地同列表，无 iframe | 本项目的目标 |
| **Host** | 一个 DSH runtime 实例（本地或远端） | `dsh web` / headless host |
| **Remote session** | 归属某个远端 Host 的 session | `remoteSessionId` |
| **Workspace identity** | 跨 host 稳定的 workspace 标识 | `workspaceIdentity` / `hostId + workspacePath` |

---

## 3. 竞品架构：Codex / ZCode

### 3.1 Codex

Codex 不是单一架构，而是 **L + B 多模式**：

| 模式 | 架构 | 说明 |
|---|---|---|
| Local / Worktree | **L** | 本地 agent + 本地沙箱；Worktree 只是在本地 Git worktree 里隔离 |
| Cloud | **B** | 在云端独立 workspace 里跑 task；本地/网页/移动端可以 start/continue/review |
| Remote connections / SSH host | **B** | session 在另一台设备/主机上；客户端使用 host 的 projects、files、credentials、permissions、tools |

关键事实（官方文档）：

- Local 和 Worktree **run on your computer**；
- Cloud task 使用 published environment，任务有独立工作文件，客户端可在 web/mobile 继续；
- Remote connections 访问的是另一台机器上的工作，不是把工具调用转发过去。

参考：
- <https://learn.chatgpt.com/docs/environments/modes>
- <https://learn.chatgpt.com/docs/remote-connections>
- Codex CLI sandbox 是本地 Seatbelt/Landlock，属于 L（纯本地），不是本项目的 A。

### 3.2 ZCode

ZCode Desktop `3.14.4` 的打包代码里能直接看到远程模式：

- 远程连接向导：`remote.wizard`、`remote.kindStep`、`remote.settingsStep`、`remote.connecting`；
- 目标类型：`remote.kind.ssh` / `remote.kind.server` / `remote.kind.docker` / `remote.kind.wsl`；
- 连接参数：`serverUrl` / `serverToken` / `serverWorkspacePath`、SSH host/port/user、私钥/passphrase、Docker container、WSL distro；
- 会话身份：`remoteSessionId`、`workspaceIdentity`、`remote services`、`workspace bridge`；
- SSH 目标有 `assetInstallMode`，会向远端安装运行时资产。

结论：ZCode 的远程模式是 **B**——远端跑 runtime，桌面用 `remoteSessionId` attach；本地 workspace 模式则是 L。以上来自对已安装 app 的静态检查，不是官方文档。

### 3.3 对 DSH 的含义

- Codex / ZCode 不是“L 或 B 二选一”，而是**同一个客户端里同时支持 L 和 B**；
- 它们的远程体验是 B，且客户端从第一天就按 host / remote session 设计；
- DSH 想达到同等体验，不能只做 A，也不能只靠 iframe；需要 B-native 的客户端改造。

---

## 4. DSH 现有能力与插件

### 4.1 可复用的 DSH 能力

| 能力 | 包/接口 | 用途 |
|---|---|---|
| Web/Host runtime | `dsh web`、`dsh-headless` | 远端直接跑一套完整 DSH |
| 类型化 Remote API | `dsh-api-gateway`、`dsh-api-remotes`、`/api/remote.mux` | Client↔Host 调用、流、事件、取消、重连 |
| Workspace registry | `dsh-workspace`、`dsh-api-workspace-controller` | workspace 列表、session 归属、排序 |
| Plugin bundle | `dsh.bundle.patch`、`cordis.patch.yml` | 本地/远端插件安装 |
| Client UI 扩展 | `dsh-client-ui-*`、slots | 设置页、侧栏、面板、命令 |
| Sandbox policy | `dsh-fs-sandbox`、`dsh-bash-sandbox` | `workspace-write` / `read-only` 策略 |

### 4.2 现有插件定位

| 插件 | 架构 | 结论 |
|---|---|---|
| `dsh-remote-development`（CJYLZS） | A | UI 100% 一样；session 本地；无远程终端、`@` 远程补全 |
| `dsh-remote-tunnel`（Linjiangxian0203） | B-lite | 远端 systemd `dsh web` + SSH 隧道 + 桌面侧栏；remote session 可持久 |
| `dsh-remote-explorer`（btsd321） | B-lite | 远端 provisioning + 隧道 + 新标签页；模型 Key 留本地 |
| `dsh-ssh-workspace`（sincerity711） | B-lite | 本地 controller + 远端 companion；统一侧栏；peer 固定在 `0.2.0-rc.2`，当前 `0.2.1-rc.2` 会被兼容门拦 |
| `dsh-remote-hosts`（catcatchcatast） | B-lite / early B | 多 host remote；目前是 `0.1.5-rc.2` preview |

### 4.3 关于沙箱

DSH 的 sandbox 是**本地策略层**：

- 限制本地文件/命令的读写范围；
- `workspace-write` / `read-only` / `danger-full-access`；
- 不是 VM/容器，不是 disposable 环境。

A 方案会把 sandbox policy 路由到远端路径；B 方案的远端 runtime 仍然是用户自己的机器/容器。真正的云沙箱属于 `dsh-remote-cloud`，不是当前范围。

---

## 5. 目标架构：B-native

### 5.1 组件图

```text
┌─────────────────────────────────────────────────────┐
│ Local DSH Client（host-aware）                       │
│  ├─ Host Registry / Connection Multiplexer           │
│  ├─ Host-scoped Workspace Store                      │
│  ├─ Host-scoped Session Store / Attach Manager       │
│  ├─ Remote Services: fs, terminal, git, approvals    │
│  └─ UI: host switcher, remote workspace list, panels │
└──────────────────────┬──────────────────────────────┘
                       │ SSH tunnel / WebSocket
                       │ typed protocol (hostId, sessionId)
┌──────────────────────▼──────────────────────────────┐
│ Remote Runtime                                       │
│  ├─ dsh web / headless host                          │
│  ├─ dsh-remote-agent bundle                          │
│  │   health / workspace list / session attach / token│
│  ├─ workspace + toolchain + git + terminal           │
│  └─ systemd / container supervision                  │
└─────────────────────────────────────────────────────┘
                       │
              optional relay / cloud
```

### 5.2 身份模型

所有跨 host 的对象必须带 host 维度：

```text
hostId              # 稳定 ID：ssh://user@host:port 或 server URL
workspaceIdentity   # hostId + canonical workspace path
remoteSessionId     # 远端 session ID（不是本地 session ID）
```

规则：

- 每个 workspace/session/event/file/terminal 都带 `hostId`；
- 本地对象 `hostId = "local"`；
- 不允许只凭 `sessionId` 查找，避免多 host 串会话；
- UI key、缓存 key、事件游标都必须包含 `hostId`。

### 5.3 协议

优先复用 DSH 现有 Remote API：

- `/api/remote.mux`（Typert Gateway）已经有 unary、stream、uplink、取消、重连；
- `dsh-api-remotes` 已经选择业务 namespace；
- 远端 `dsh web` 本身就能提供这些接口。

需要新增/封装的语义：

| 能力 | 说明 |
|---|---|
| `host.info` | 版本、平台、home、能力集 |
| `workspace.list` / `workspace.follow` | 远端 workspace 投影 |
| `session.list` / `session.attach` / `session.resume` | 远端 session 列表与 attach |
| `session.events` | 结构化事件流；带 cursor，支持断线重放 |
| `approval.*` / `question.*` | 审批与提问路由到本地 UI |
| `terminal.*` | PTY 流、resize、detach/reattach |
| `file.*` / `git.*` | 远端文件与 git 操作 |
| `health` / `version` | 兼容性协商 |

协议要求：

- `protocolVersion` 协商；本地插件与远端 agent 不匹配时明确拒绝，不要静默降级；
- attach 使用“snapshot + cursor”，断线后先拿 baseline，再补增量；
- 事件幂等；重复 attach 不重复执行工具；
- 所有请求带 `hostId` / `remoteSessionId`；
- 认证走 SSH 隧道 + 短期 token；relay 模式再加 mTLS / 设备配对。

### 5.4 客户端改造（核心难点）

DSH 客户端目前是单 Host。B-native 需要改这些层：

1. **Connection 层**
   - 从“一个连接”变成“每个 host 一个连接”；
   - 统一重连、心跳、取消、错误分类；
   - 本地 host 和远端 host 使用同一套接口。

2. **Workspace Store**
   - workspace 记录增加 `hostId` / `workspaceIdentity`；
   - 本地与远端 workspace 同一列表，分组/排序/过滤；
   - 删除/重命名只影响对应 host。

3. **Session Store**
   - 本地 session 与 remote session 统一投影；
   - remote session 的 attach/resume 状态机；
   - 事件游标、去重、gap repair；
   - 审批/问题/计划评审的跨 host 路由。

4. **服务路由**
   - `fs` / `terminal` / `git` / `search` 按 `hostId + sessionId` 选择实现；
   - 不允许“当前 host”这种隐式全局状态；
   - 关闭 session 时释放对应远端连接/PTY。

5. **UI**
   - host switcher / host badge；
   - remote workspace 标记；
   - 连接状态、重连提示、错误面板；
   - 远程终端/文件/diff 与本地同组件，不同数据源。

**实现策略**：

- 先做 **patch set**，不要一上来 fork 整个 DSH；
- `dsh-remote-client` 只放 host-aware 的 seam 和补丁；
- 如果上游接受，补丁回流，repo 2 可以退化成 thin shell 或删除；
- 如果上游不接受，再升级为 fork，仍然只维护 patch 层。

### 5.5 远端运行时

- 复用 `dsh web` 或 `dsh-headless`，不重写 agent loop；
- 安装 `dsh-remote-agent` bundle：health、workspace list、session attach、token、版本协商；
- 工作区、工具链、git、终端都在远端；
- 生命周期：
  - 单机：systemd（system/user unit）或进程管理；
  - 容器：容器 entrypoint + healthcheck；
  - 云：sandbox orchestrator（后续）。
- 资源清理：session 结束、idle timeout、显式 stop；
- 升级：agent 版本与客户端协议版本解耦，按兼容矩阵升级。

### 5.6 凭据模型

优先方案（推荐）：

- 默认直连模式下模型 API Key 存在于远端 service 环境；代理模式下只存在本地；
- 本地起一个反向代理/隧道端点；
- 代理模式下远端 runtime 使用占位 token，请求经隧道回到本地代理，由本地注入真实 key；
- 代理模式下远端磁盘上不落真实 key；直连模式会写入远端 service 环境。

备选：

- 远端 secret store（系统 keychain / 文件 0600）；
- 适合共享服务器/团队场景，但需要明确信任边界。

### 5.7 安全边界

- 远端 agent 拥有用户 shell 权限；只连接可信机器；
- 远端 `dsh web` 只监听 loopback，不暴露公网；
- SSH host key 校验（TOFU / verify）；
- 短期 token + 设备配对；
- 审计日志（命令、attach、文件写入）；
- 多租户隔离是 `dsh-remote-cloud` 的问题，不要在插件层假装解决。

---

## 6. 仓库拆分

### 6.1 推荐结构

| 仓库 | 内容 | 为什么独立 | 何时 |
|---|---|---|---|
| **`dsh-remote`** | `packages/protocol`、`local-plugin`、`remote-agent`、`installer`、`testkit` | 插件和远端 agent 共用协议，必须同步发版；pnpm workspace 管理 | 今天 |
| **`dsh-remote-client`** | host-aware 客户端 patch/fork：connection、workspace store、session store、remote panels | 跟踪 DSH 上游，发版节奏不同；fork/patch 需要独立 rebase | 今天/下一步 |
| **`dsh-remote-relay`** | outbound WebSocket relay、NAT 穿透、认证 | 独立服务、独立信任边界；SSH-only 不需要 | 需要 NAT/云时 |
| **`dsh-remote-cloud`** | 沙箱编排、PR、多租户、infra | 运维/安全/计费，和插件不是一类东西 | 做云版时 |

### 6.2 `dsh-remote` 目录

```text
dsh-remote/
  packages/
    protocol/        # 类型、schema、版本协商、错误码
    local-plugin/    # DSH desktop profile 插件：host 管理、连接、UI
    remote-agent/    # 远端 DSH profile companion：health/attach/workspace/session
    installer/       # bootstrap CLI：Node/dsh/systemd/container
    testkit/         # fake remote host、契约测试
  docs/
  examples/
```

### 6.3 `dsh-remote-client` 目录

```text
dsh-remote-client/
  upstream.md        # pin 的 DSH 版本/commit
  patches/           # host-aware 改动
  scripts/apply.sh   # 应用到 pinned upstream
  packages/          # 必要的新 seam（不复制整个 DSH）
```

### 6.4 依赖方向

```text
dsh-remote-client  ──depends on──▶  dsh-remote/packages/protocol
dsh-remote/remote-agent  ──uses──▶  DSH runtime (dsh web / headless)
dsh-remote-relay  ──speaks──▶  protocol
dsh-remote-cloud  ──orchestrates──▶  relay + runtime images
```

### 6.5 为什么不只是一个仓库

- 客户端 patch/fork 要跟踪 DSH 上游，和插件/agent 的发版节奏不同；
- 远端 agent 要独立安装到远端机器，不能跟客户端一起发版；
- relay 是独立服务，信任边界/部署/扩缩容都不同；
- 云编排是运维项目，不是 DSH 插件。

### 6.6 为什么不拆更多

- `protocol` 先做 package，不做独立仓库；没有第三方实现者时，独立仓库只会增加跨仓库发版成本；
- `installer`、`testkit` 同理，留在 `dsh-remote`；
- 等出现外部 agent 实现者，再把 protocol 拆出去。

---

## 7. 分阶段计划与验收

### Phase 0：B-lite（最快可用）

- 远端 `dsh web` + SSH 隧道 + 桌面侧栏/标签页；
- 远端 systemd / 进程管理；
- 本地 host 管理、连接状态、重连；
- 远端 session 可持久（关掉本地后仍在跑）。

验收：

- 从零到远端 DSH 在桌面侧栏打开；
- 断网后隧道自动重连；
- 远端 session 在本地关闭后仍可重新 attach；
- 不暴露公网端口。

### Phase 1：协议 + 远端 agent + 本地 host 管理

- `protocol` 包：host/workspace/session/attach/event/terminal 消息；
- `remote-agent`：health、workspace list、session attach、token；
- `local-plugin`：host registry、连接、生命周期、设置页；
- 契约测试：fake remote host + 双端协议测试。

验收：

- 本地插件能列出远端 workspace；
- 能 attach 一个远端 session 并收到事件流；
- 版本不匹配时明确报错；
- 认证/主机指纹/审计可用。

### Phase 2：B-native 客户端

- `dsh-remote-client` patch：host-scoped connection/workspace/session；
- 远端 workspace/session 进入本地列表；
- 远程 session 在本地主区域打开，无 iframe；
- 文件/终端/diff/审批路由；
- attach/resume + 事件游标 + 重连。

验收：

- 点开远程工程 → 点开会话 → 直接对话；
- 关掉本地客户端，远端任务继续；
- 重开客户端，session 恢复，审批不丢；
- 多 host 切换不串会话/文件；
- 终端、文件树、diff 都指向正确 host；
- 本地与远端 workspace 同一列表。

### Phase 3：relay / NAT

- outbound WebSocket relay；
- 设备配对、token、mTLS；
- 无公网 IP / 无入站端口场景；
- relay 只做路由，不解密业务载荷（或明确 TLS 终止边界）。

### Phase 4：cloud（当前非目标）

- 容器/VM 编排、快照、预热；
- 异步任务队列；
- PR/artifact；
- 多租户、配额、计费。

---

## 8. 风险与开放问题

| 问题 | 影响 | 建议 |
|---|---|---|
| DSH 上游是否接受 host-aware 改动 | 决定 repo 2 是 patch 还是 fork | 先做最小 patch，和上游沟通；保留 fork 退路 |
| `/api/remote.mux` 能否跨 host 复用 | 决定协议是复用还是新写 | 先做 spike：远程 `dsh web` + 本地 client 代理调用 |
| session attach/resume 语义 | 断线重连/审批丢失 | 先定 cursor + snapshot + 幂等；写契约测试 |
| 多 host 客户端改造范围 | 工作量最大 | 先做 connection + workspace/session store 两个 seam，UI 后置 |
| 远端 UI 的 iframe/cookie 限制 | B-lite 的坑 | B-lite 只做过渡；B-native 不走 iframe |
| 凭据落盘 | 安全 | 默认本地代理；远端 secret store 作为显式选项 |
| 远端平台 | Linux/macOS/Windows/WSL/Docker | 先 Linux + SSH；其他按需求加 |
| DSH prerelease API 漂移 | 插件/客户端兼容 | pin 版本；协议版本协商；CI 兼容矩阵 |
| 性能 | SSH/SFTP/终端延迟 | 连接复用、批量请求、PTY 背压；压测 |
| 许可/合规 | fork/分发 | 保留 MIT/版权；patch 集明确来源 |

### 待定决策

- [ ] repo 2 先 patch 还是直接 fork？
- [ ] 协议复用 `/api/remote.mux` 还是新增 envelope？
- [ ] 远端 runtime 用完整 `dsh web` 还是 headless host + 最小 UI？
- [ ] 模型凭据默认本地代理还是远端 secret store？
- [ ] 第一版支持哪些 target：SSH only / +server / +Docker / +WSL？
- [ ] 是否把 `dsh-remote-client` 的改动提交上游？

---

## 9. 交接清单（在新 project 中开始）

1. 建 `dsh-remote` 仓库，pnpm workspace，先落 `protocol`、`local-plugin`、`remote-agent`、`installer`、`testkit` 五个 package。
2. 建 `dsh-remote-client` 仓库，先放 `upstream.md` + `patches/` + `apply.sh`，不要复制整个 DSH。
3. 写 ADR-001：协议复用 vs 新 envelope。
4. 写 ADR-002：repo 2 patch vs fork。
5. 做 spike：远程 `dsh web` + SSH 隧道 + 本地 client 代理一个 `workspace.list` 调用。
6. 用 fake remote host 写契约测试，先于 UI。
7. Phase 0 先交付 B-lite，确保 remote session 持久/重连。
8. Phase 2 再动 host-scoped store，避免一开始就重构整个客户端。

### MVP backlog（建议顺序）

- [ ] `protocol`：消息类型、版本协商、错误码
- [ ] `remote-agent`：health、workspace list、session attach、token
- [ ] `installer`：bootstrap Node/dsh、systemd/container、隧道
- [ ] `local-plugin`：host registry、连接、设置页、状态
- [ ] `testkit`：fake host + 协议契约测试
- [ ] `dsh-remote-client`：connection 多 host seam
- [ ] `dsh-remote-client`：workspace/session host-scoped store
- [ ] UI：host switcher、remote workspace/session、terminal/diff/approvals
- [ ] 安全：host key、token、审计、凭据代理
- [ ] 验收：断线重连、attach/resume、多 host 隔离

---

## 10. 参考资料

### Codex

- Codex environments: <https://learn.chatgpt.com/docs/environments/modes>
- Codex remote connections: <https://learn.chatgpt.com/docs/remote-connections>
- Codex CLI sandboxing: <https://mintlify.wiki/openai/codex/architecture/sandboxing>

### DSH

- `@deepseek-ai/dsh-api-gateway`：`/api/remote.mux`、unary/stream/uplink/reconnect
- `@deepseek-ai/dsh-api-remotes`：Host Remote 能力选择与 Client 装配
- `@deepseek-ai/dsh-workspace`：workspace registry
- `@deepseek-ai/dsh-api-workspace-controller`：workspace/session 投影
- `@deepseek-ai/dsh-headless`：一次性 agent runner
- `@deepseek-ai/dsh-web-app`：Web 客户端 bundle

### 现有插件

- `dsh-remote-development`（A）：<https://github.com/CJYLZS/dsh-remote-development>
- `dsh-remote-tunnel`（B-lite）：<https://github.com/Linjiangxian0203/dsh-remote-tunnel>
- `dsh-remote-explorer`（B-lite）：<https://github.com/btsd321/dsh-remote-explorer>
- `dsh-ssh-workspace`（B-lite）：<https://github.com/sincerity711/dsh-ssh-workspace>
- `dsh-remote-hosts`（B-lite preview）：<https://github.com/catcatchcatast/dsh-remote-hosts>

### 本仓库现有产物

- `remote-dev-kit/README.md`：A 方案的安装/验收套件
- `remote-dev-kit/install.sh`：安装 `dsh-remote-development`
- `remote-dev-kit/verify.sh`：检查插件/anchor/SSH/rg
