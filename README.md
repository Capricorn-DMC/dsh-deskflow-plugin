# dsh-deskflow-plugin

把 [Deskflow](https://github.com/deskflow/deskflow) 键鼠共享功能做成 **DeepSeek Harness（DSH）桌面客户端的原生插件**。

在局域网内自动发现同样安装了本插件（或 Deskflow fork 版）的电脑，弹出角色协商提示（服务端 / 客户端），选择后自动写入 Deskflow 配置并拉起 Deskflow 后端完成键鼠共享连接。

## 功能

- **左侧菜单入口**：在 DSH 侧栏底部（设置按钮旁）注入「⌨ 键鼠共享」按钮，点开浮动面板
- **局域网自动发现**：UDP 40801 广播（1.5s 周期 / 6s 超时），与 Deskflow fork 内置 C++ 发现协议完全兼容
- **角色协商弹窗**：发现新设备自动弹窗，二选一：
  - 本机作为**服务端** —— 用本机键鼠控制对方
  - 本机作为**客户端** —— 使用对方键鼠控制本机
- **自动连接（headless 无窗口）**：写 Deskflow QSettings 配置后直接拉起后台核心 `deskflow-core.exe`（服务端自动登记屏幕与边缘切换链接），全程无 Deskflow 窗口，交互都在插件面板完成
- **AI 工具**：向 DSH 注册 4 个可被智能体调用的工具
  - `deskflow_status` / `deskflow_scan_peers` / `deskflow_connect` / `deskflow_disconnect`

## 环境要求

- DeepSeek Harness 桌面客户端（DSH 0.2.1+，支持 `~/.dsh/profiles/desktop` 外部插件）
- Deskflow 后端：`deskflow-core.exe` + DLL，默认放在 `~/.dsh/deskflow-backend/`（与官方安装版无关，卸载官方 Deskflow 不影响本插件）
- Windows（配置写入逻辑依赖 `%APPDATA%` 路径与 QSettings ini 格式）

## 安装

### 第 1 步：clone 仓库（后端无需手动解压）

仓库内已附带后端压缩包 **`deskflow-backend-win64.zip`**（Windows x64，含 `deskflow-core.exe` 及全部运行时 DLL）。

```powershell
git clone https://github.com/Capricorn-DMC/dsh-deskflow-plugin.git
```

**首次启动核心时会自动解压**：插件检测到 `~/.dsh/deskflow-backend/deskflow-core.exe` 缺失时，会自动把仓库内的 zip 解压到该目录（约需十几秒）。

如果想提前手动解压（可选）：

```powershell
Expand-Archive -Path .\dsh-deskflow-plugin\deskflow-backend-win64.zip `
  -DestinationPath "$env:USERPROFILE\.dsh\deskflow-backend"
```

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
| `backendDir` | `~/.dsh/deskflow-backend` | 后端目录（含 `deskflow-core.exe` / `deskflow.exe`） |
| `launchMode` | `headless` | `headless`=后台核心无窗口；`gui`=拉起 Deskflow 窗口 |
| `layout` | `right` | 服务端模式下对端屏幕相对本机的方向（right/left/top/bottom） |
| `port` | `24800` | 本机 Deskflow core 端口（随发现广播一起声明） |

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

| 日期 | 现象 | 原因与修复 |
|---|---|---|
| 2026-11 | 面板提示 `Unknown method: discovery` | DSH host 端运行的是旧版 index.js（UI 新 / host 旧）。**完全退出并重启 DeepSeek Harness** 使 host 重新加载插件即可；面板底部会显示 `UI vX / Host vY`，版本不一致时先重启 |
| 2026-11 | 两端插件互不可见 / 添加设备连接失败 | DSH RPC 契约不匹配：host 侧曾返回 `{ok:true, result}`，而 DSH 契约要求 `{ok:true, value}`（失败为 `{ok:false, error:{code,message,details}}`）。已在 index.js 统一为契约形状，client.js 的 `hostCall` 同时做映射容错。**两端需保持插件版本一致**（git pull 后重启 DSH） |
| 2026-11 | 服务端显示"已连接"但键鼠不通，重连报 `server already has a connected client with name "xxx"` | 客户端 core 异常退出后服务端残留**僵尸会话**（假在线），拒绝新连接。v1.2.1 起服务端 conf 写入 `server/enableHeartbeat=true`（5000ms）：客户端失联约 3 个心跳周期（~15 秒）即被服务端剔除。旧版需在服务端手动重启 Deskflow 会话清掉死连接 |

## 已知限制

- 后端包 `deskflow-backend-win64.zip` 自带全部运行依赖：deskflow-core/deskflow/deskflow-daemon + Qt6 DLL/插件 + OpenSSL 3（`libssl-3-x64.dll`、`libcrypto-3-x64.dll`）+ VC++ 运行时（VCRUNTIME140/MSVCP140 等），解压到 `~/.dsh/deskflow-backend` 即可运行，**无需单独安装 Qt/OpenSSL/VC++ 运行库**（首次使用自动解压）
- headless 模式统一关闭 TLS（`security/tlsEnabled=false`，插件无证书生成能力），LAN 内明文传输，与 Deskflow fork 互操作时对端也需关闭
- 若对端曾用 Deskflow GUI 改过计算机名（`core/computerName`），屏幕名与发现广播的 hostname 不一致会连接失败；默认两边都用主机名即可
- 启动前会 `taskkill` 同名旧进程（孤儿实例清理），同机只能运行一个 core

## License

[GPL-3.0](./LICENSE) —— 本插件发现协议实现源自 GPL-3.0 项目的 Deskflow fork 源码。
