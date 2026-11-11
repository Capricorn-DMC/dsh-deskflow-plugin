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

## 版本兼容记录

当前版本 **1.1.0**：`package.json` 的 `version`、`index.js` 的 `PLUGIN_VERSION`、`client.js` 的 `UI_VERSION` 三处一致，面板底部显示 `UI v1.1.0 / Host v1.1.0`。

| 现象 | 原因 | 现状（1.1.0） |
|---|---|---|
| 面板提示 `Unknown method: discovery` | DSH host 侧跑的还是旧 `index.js`（UI 新 / host 旧） | 完全退出并重启 DeepSeek Harness 才会重新加载插件。面板底部的 `UI vX / Host vY` 就是为这个准备的，两者不一致先重启 |
| 两端插件互不可见、或添加设备后连接失败 | DSH RPC 契约不匹配：host 侧曾返回 `{ok:true, result}`，契约要求 `{ok:true, value}`（失败为 `{ok:false, error:{code,message,details}}`） | index.js 已统一为契约形状，client.js 的 `hostCall` 同时做映射容错。**两端保持同一版本**，`git pull` 后两端都要重启 DSH |
| 服务端显示"已连接"但键鼠不通，重连报 `server already has a connected client with name "xxx"` | 客户端 core 异常退出后服务端残留**僵尸会话**（假在线），拒绝新连接 | 不再靠心跳踢会话，改为从源头避免第二个同名连接（接管机制）；真出现僵尸会话时，在对端断开重连或重启 core 即可清掉 |
| 服务端开启心跳后，连接在握手约 10 秒后准时断一次并循环重连 | `server/enableHeartbeat=true` 每 5s 往客户端 socket 写一次，写失败即掐断连接（10s = 2 个心跳周期，整齐得不像网络抖动） | `heartbeat` 默认 **false**；确需僵尸会话检测再显式开启，并把 `heartbeatInterval` 调到 30000 以上 |
| 切到对端后光标卡在屏幕边缘、被弹回，日志同时出现 `already connected` | 同机存在两个同名客户端 core，互相把对方 socket 踢下线（旧进程没清掉，而 `taskkill` 对提权进程是静默失败） | 启动前清理并**复查残留**；签名一致直接接管、不产生第二个进程；残留清不掉就拒绝启动并给出 PID。**这不是权限问题**——非管理员同样能注入键鼠 |
| 连接时提示「有 1 个旧的 deskflow-core.exe 结束不掉（PID x）」 | 探活用 `process.kill(pid, 0)` 的异常判断生死，而 Windows 下对提权进程它抛的是 `EPERM`（进程活着），于是现存核心既没被接管、也杀不掉 | `EPERM` 视为存活、`ESRCH` 才是真退出；杀不掉时保留签名，下次仍可接管。报错会一并说明没能接管的原因（角色/对端/布局不一致，或无签名记录） |

前提条件：**两端插件版本一致，且两端都重启过 DSH**。UI 与 host 不一致时，问题通常以 `Unknown method` 或参数缺失的形式暴露出来。

DSH 版本要求：`0.2.1+`（依赖 `~/.dsh/profiles/*/node_modules/@local/*` 外部插件加载与 `connection.fetch` 的 RPC 注册）。

## 已知限制

- **后端随仓库附带**（`backend/`：deskflow-core / deskflow / deskflow-daemon + Qt6 DLL 与插件 + OpenSSL 3 + VC++ 运行时），clone 即用，无需单独安装 Qt/OpenSSL/VC++；与官方 Deskflow 安装版互不影响，卸载官方版也不影响本插件
- **headless 模式关闭 TLS**（`security/tlsEnabled=false`）：插件没有证书生成能力，LAN 内明文传输；与 Deskflow fork 互操作时对端也需关闭
- **不需要管理员权限**：普通权限进程就能注入键鼠（本机服务端实测如此）。只有两种情形会失效——前台停在提权窗口（任务管理器、UAC 弹窗）时注入被 UIPI 拦截，或对端停在锁屏/登录界面。插件不会把"未提权"当作连接告警
- **同机只允许一个 core**：启动前 `taskkill` 同名旧进程并复查；残留清不掉（典型场景：旧 core 以管理员启动、当前 DSH 没有）就**拒绝启动**，不会为了连上而制造两个同名客户端互踢，报错会带上残留 PID
- **关掉 DSH 不会停核心**（`keepRunningOnExit` 默认 `true`）：键鼠共享不中断，下次打开界面直接接管同一个进程；想"关界面即停"设成 `false`，此时在 `process.exit`、`SIGINT/SIGTERM/SIGHUP/SIGBREAK`、cordis `dispose` 里结束核心
- **不做心跳保活**（`heartbeat` 默认 `false`）：代价是不主动清理僵尸会话，由"签名一致才接管、不一致才重启"覆盖；确需检测时显式开启并把间隔拉长到 30s 以上
- **探活不能只看 `process.kill(pid, 0)` 的异常**：Windows 下对提权/高完整性进程它抛的是 `EPERM`（进程活着，只是无权访问），一律当"已退出"会让提权运行的核心既无法接管、又杀不掉，最终报一句极具误导性的"结束不掉"
- **DSH 被任务管理器强杀**：`exit` 钩子不会触发，核心会残留；下次连接按签名接管或清理，不需要手工收拾
- **GUI 与 headless 不互相接管**：`launchMode` 不同会导致签名不一致（`mode` 字段不同），切换模式会重启核心
- **屏幕名 = 计算机主机名**：若对端曾用 Deskflow GUI 改过 `core/computerName`，屏幕名与发现广播的 hostname 不一致会连接失败；默认两边都用主机名即可
- **对端开 VPN（TUN 模式）可能吞掉发现广播**：已内置单播兜底（对见过的对端 IP 直接单播 announce，缓存于 `~/.dsh/deskflow-peers.json`）；首次发现或缓存失效时，可在 cordis 配置 `staticPeers` 写死对端 IP，或临时关 VPN 完成首次配对

## License

[GPL-3.0](./LICENSE) —— 本插件发现协议实现源自 GPL-3.0 项目的 Deskflow fork 源码。
