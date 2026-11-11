# dsh-deskflow-plugin

把 [Deskflow](https://github.com/deskflow/deskflow) 键鼠共享功能做成 **DeepSeek Harness（DSH）桌面客户端的原生插件**。

在局域网内自动发现同样安装了本插件（或 Deskflow fork 版）的电脑，弹出二选一：**用本机键鼠控制对方**（本机作服务端）或**用对方键鼠控制本机**（本机作客户端），选择后自动写入 Deskflow 配置并拉起 Deskflow 后端完成键鼠共享连接。

## 功能

- **左侧菜单入口**：在 DSH 侧栏底部（设置按钮旁）注入「⌨ 键鼠共享」按钮，点开浮动面板
- **局域网自动发现**：UDP 40801 广播（1.5s 周期 / 6s 超时），与 Deskflow fork 内置 C++ 发现协议完全兼容
- **角色协商弹窗**：发现新设备自动弹窗，二选一：
  - 本机作为**服务端** —— 用本机键鼠控制对方
  - 本机作为**客户端** —— 使用对方键鼠控制本机
- **自动连接（headless 无窗口）**：写 Deskflow QSettings 配置后直接拉起后台核心 `deskflow-core.exe`（服务端自动登记屏幕与边缘切换链接），全程无 Deskflow 窗口，交互都在插件面板完成
- **AI 工具**：向 DSH 注册 5 个可被智能体调用的工具
  - `deskflow_status` / `deskflow_scan_peers` / `deskflow_connect` / `deskflow_disconnect` / `deskflow_doctor`（自检：多实例、防火墙、核心状态）
- **进程接管**：关掉 DSH 后后台核心继续跑，下次连接按签名（pid/角色/对端/布局/模式）沿用同一个进程，不再产生第二个同名客户端互踢

## 环境要求

- DeepSeek Harness 桌面客户端（DSH 0.2.1+，支持 `~/.dsh/profiles/desktop` 外部插件）
- Deskflow 后端：插件仓库自带 `backend/` 目录（`deskflow-core.exe` + 全部依赖 DLL），clone 即用，**无需安装 Qt/OpenSSL/VC++ 运行库**（与官方安装版无关，卸载官方 Deskflow 不影响本插件）
- Windows（配置写入逻辑依赖 `%APPDATA%` 路径与 QSettings ini 格式）

## 安装

### 第 1 步：clone 仓库（后端已附带，无需解压）

```powershell
git clone https://github.com/Capricorn-DMC/dsh-deskflow-plugin.git
```

仓库内 `backend/` 目录即后端本体（Windows x64：`deskflow-core.exe` + Qt6 DLL + OpenSSL 3 + VC++ 运行时），插件启动时优先使用该目录；如需放到别处，可配置 `backendDir` 指向含 `deskflow-core.exe` 的目录（如旧版的 `~/.dsh/deskflow-backend/`）。

### 第 2 步：注册插件到 DSH profile

编辑 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "@local/deskflow": "link:C:/path/to/dsh-deskflow-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@local/deskflow"
      ]
    }
  }
}
```

建立链接（Windows，其余平台用 `ln -s`）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\deskflow" `
  -Target "C:\path\to\dsh-deskflow-plugin"
```

重启 DeepSeek Harness 客户端，侧栏底部出现「⌨ 键鼠共享」即安装成功。

### 第 3 步：防火墙放行（两端都要，插件内一键完成）

插件启动后自动检测防火墙规则（UDP 40801 发现 / TCP 24800 键鼠连接）。未放行时面板会出现黄色警示条，点**「一键放行（需管理员授权）」**，在系统 UAC 弹窗点「是」即可自动添加两条入站规则。

也可以手动放行（管理员 PowerShell）：

```powershell
New-NetFirewallRule -DisplayName "DSH Deskflow Discovery" -Direction Inbound -Protocol UDP -LocalPort 40801 -Action Allow
New-NetFirewallRule -DisplayName "DSH Deskflow Core" -Direction Inbound -Protocol TCP -LocalPort 24800 -Action Allow
```

## 配置

插件 cordis 配置项（可选）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `backendDir` | 插件自带 `backend/` | 后端目录（含 `deskflow-core.exe` / `deskflow.exe`），默认用仓库内 `backend/`，可指向其他位置 |
| `launchMode` | `headless` | `headless`=后台核心无窗口；`gui`=拉起 Deskflow 窗口 |
| `layout` | `right` | 服务端模式下对端屏幕相对本机的方向（right/left/top/bottom） |
| `port` | `24800` | 本机 Deskflow core 端口（随发现广播一起声明） |
| `staticPeers` | `[]` | 固定对端 IP 列表（如 `["192.168.100.101"]`）：广播被 VPN/网络策略吞掉时以单播兜底互相发现 |
| `keepRunningOnExit` | `true` | `true`=关闭 DSH 后核心继续跑（键鼠共享不中断，下次连接直接接管）；`false`=关界面即停核心 |
| `heartbeat` | `false` | 服务端心跳检测。默认关闭：5s 心跳写失败会在握手约 10s 后掐断连接；确需僵尸会话检测时开启并配 `heartbeatInterval`（建议 ≥30000） |
| `heartbeatInterval` | `30000` | 心跳间隔（毫秒），仅在 `heartbeat: true` 时生效 |

### 进程生命周期：接管而不是重启

后台核心用 `detached` 启动，DSH 关掉后它仍在跑、连接也还在——界面关掉后键鼠共享继续可用，这本身是想要的行为。

真正的坑在"重新连接"：再 spawn 一个同名客户端，服务端日志就会出现 `a client with name "xxx" is already connected` 并踢掉旧 socket，旧核心随即重连，两个进程互踢，表现就是切屏抖动、偶发断线。

所以做法是**接管**：

- 拉起核心时把签名（pid / 角色 / 对端 / 布局 / 模式）写进 `~/.dsh/deskflow-core.state.json`
- 下次连接先读这份记录：pid 还活着、且确实是 `deskflow-core.exe`（防 pid 复用）、角色/对端/布局/模式全都一致 → **直接沿用**，不再起第二个进程，也不打断现有连接
- 签名不一致才清理重启，保证不会"点了连接、实际连的还是上次那台"

配套规则：

- **默认不杀核心**（`keepRunningOnExit: true`）；想"关界面即停"的设 `false`，此时插件在 `process.exit`、`SIGINT/SIGTERM/SIGHUP/SIGBREAK`、cordis `dispose` 里结束核心
- **旧实例清不掉就拒绝启动**：`taskkill` 结束提权进程会静默失败（典型场景：旧 core 以管理员启动、当前 DSH 没有），这时宁可报错让你处理，也不会再起一个去互踢。提示里会带上残留 PID
- **DSH 被任务管理器强杀**：`exit` 钩子不触发，但不影响下次连接——签名一致就接管，不一致就清理，都不需要手工收拾

## 工作原理

```
┌─ DeepSeek Harness 客户端 ─────────────┐      ┌─ 对端电脑（同样安装）─┐
│  Web UI (client.js)                   │      │                       │
│   └ sidebar.footer.action 按钮/面板   │      │                       │
│       └ RPC /api/deskflow             │◄────►│  UDP 40801 广播互相   │
│           └ Host (index.js)           │ RPC  │  发现，协商角色后     │
│               ├ dgram UDP 40801 发现  │      │  各自启动后台 core    │
│               ├ 写 DeepSeek Harness   │      │  (24800 TCP)          │
│               │   .conf（QSettings）  │      │                       │
│               └ spawn deskflow-core   │      │                       │
│                   （headless 无窗口） │      │                       │
└───────────────────────────────────────┘      └───────────────────────┘
```

- 发现协议：UDP 广播 JSON `{proto:"deepseek-harness", ver:1, instance:<uuid>, name, port, leaving}`，与 Deskflow fork 的 C++ `LanDiscovery` 一致，可互操作
- 连接动作 = 修改 `%APPDATA%\DeepSeek Harness\DeepSeek Harness.conf`（`core/coreMode`、`client/remoteHost`、`security/tlsEnabled=false`，服务端额外写 `[computer_N]` 屏幕分组 + `deskflow-server.conf` 边缘切换链接）+ 后台启动 `deskflow-core.exe server|client -s <conf>`，Deskflow 原有全部功能不受影响
- 屏幕名 = 计算机主机名（与 core 默认自命名一致）；screens 存于通用配置 `[computer_N]` 分组，server config 文件只承载 links/options（本版本 Deskflow 行为）

## 排障要点

- **两端插件版本一致，且两端都重启过 DSH**：UI 与 host 不一致时，问题通常以 `Unknown method` 或参数缺失的形式暴露出来。面板底部显示 `UI vX / Host vY`，两者不一致先彻底重启 DSH
- **版本号三处一致**：`package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`、`client.js` 的 `UI_VERSION`
- DSH 版本要求：`0.2.1+`（依赖 `~/.dsh/profiles/*/node_modules/@local/*` 外部插件加载与 `connection.fetch` 的 RPC 注册）
- manifest 校验：`dsh.client.inject` 必须是字符串数组（写成字符串会导致 DSH 启动失败）
- 改 `package.json` 后先 `JSON.parse` 校验、确认无 BOM 再提交（历史上 BOM 和 manifest 格式各炸过一次启动）

## 已知限制

- **headless 模式关闭 TLS**（`security/tlsEnabled=false`）：插件没有证书生成能力，LAN 内明文传输；与 Deskflow fork 互操作时对端也需关闭
- **不需要管理员权限**：普通权限进程就能注入键鼠（本机服务端实测如此）。只有两种情形会失效——前台停在提权窗口（任务管理器、UAC 弹窗）时注入被 UIPI 拦截，或对端停在锁屏/登录界面。插件不会把"未提权"当作连接告警
- **同机只允许一个 core**：残留清不掉（典型场景：旧 core 以管理员启动、当前 DSH 没有）就**拒绝启动**，不会为了连上而制造两个同名客户端互踢，报错会带上残留 PID
- **DSH 被任务管理器强杀**：`exit` 钩子不会触发，核心会残留；下次连接按签名接管或清理，不需要手工收拾
- **GUI 与 headless 不互相接管**：`launchMode` 不同会导致签名不一致（`mode` 字段不同），切换模式会重启核心
- **屏幕名 = 计算机主机名**：若对端曾用 Deskflow GUI 改过 `core/computerName`，屏幕名与发现广播的 hostname 不一致会连接失败；默认两边都用主机名即可
- **对端开 VPN（TUN 模式）可能吞掉发现广播**：已内置单播兜底（对见过的对端 IP 直接单播 announce，缓存于 `~/.dsh/deskflow-peers.json`）；首次发现或缓存失效时，可在 cordis 配置 `staticPeers` 写死对端 IP，或临时关 VPN 完成首次配对

## License

[GPL-3.0](./LICENSE) —— 本插件发现协议实现源自 GPL-3.0 项目的 Deskflow fork 源码。
