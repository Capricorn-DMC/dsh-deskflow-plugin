# dsh-deskflow-plugin

把 [Deskflow](https://github.com/deskflow/deskflow) 键鼠共享功能做成 **DeepSeek Harness（DSH）桌面客户端的原生插件**。

在局域网内自动发现同样安装了本插件（或 Deskflow fork 版）的电脑，弹出角色协商提示（服务端 / 客户端），选择后自动写入 Deskflow 配置并拉起 Deskflow 后端完成键鼠共享连接。

## 功能

- **左侧菜单入口**：在 DSH 侧栏底部（设置按钮旁）注入「⌨ 键鼠共享」按钮，点开浮动面板
- **局域网自动发现**：UDP 40801 广播（1.5s 周期 / 6s 超时），与 Deskflow fork 内置 C++ 发现协议完全兼容
- **角色协商弹窗**：发现新设备自动弹窗，二选一：
  - 本机作为**服务端** —— 用本机键鼠控制对方
  - 本机作为**客户端** —— 使用对方键鼠控制本机
- **自动连接**：写 Deskflow QSettings 配置（coreMode / remoteHost / startCoreWithGui，服务端自动登记对端屏幕）后自动拉起 deskflow.exe
- **AI 工具**：向 DSH 注册 4 个可被智能体调用的工具
  - `deskflow_status` / `deskflow_scan_peers` / `deskflow_connect` / `deskflow_disconnect`

## 环境要求

- DeepSeek Harness 桌面客户端（DSH 0.2.1+，支持 `~/.dsh/profiles/desktop` 外部插件）
- Deskflow 可执行程序（本插件默认指向自编译 fork 版 `deskflow.exe`，路径可配置）
- Windows（配置写入逻辑依赖 `%APPDATA%` 路径与 QSettings ini 格式）

## 安装

```bash
git clone https://github.com/Capricorn-DMC/dsh-deskflow-plugin.git
```

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

## 配置

插件 cordis 配置项（可选）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `deskflowPath` | `DeepSeekHarness-build/deskflow.exe` | Deskflow 可执行文件路径 |
| `port` | `24800` | 本机 Deskflow core 端口（随发现广播一起声明） |

## 工作原理

```
┌─ DeepSeek Harness 客户端 ─────────────┐      ┌─ 对端电脑（同样安装）─┐
│  Web UI (client.js)                   │      │                       │
│   └ sidebar.footer.action 按钮/面板   │      │                       │
│       └ RPC /api/deskflow             │◄────►│  UDP 40801 广播互相   │
│           └ Host (index.js)           │ RPC  │  发现，协商角色后     │
│               ├ dgram UDP 40801 发现  │      │  各自启动 Deskflow    │
│               ├ 写 DeepSeek Harness   │      │  core (24800 TCP)     │
│               │   .conf（QSettings）  │      │                       │
│               └ spawn deskflow.exe    │      │                       │
└───────────────────────────────────────┘      └───────────────────────┘
```

- 发现协议：UDP 广播 JSON `{proto:"deepseek-harness", ver:1, instance:<uuid>, name, port, leaving}`，与 Deskflow fork 的 C++ `LanDiscovery` 一致，可互操作
- 连接动作 = 修改 `%APPDATA%\DeepSeek Harness\DeepSeek Harness.conf`（`core/coreMode`、`client/remoteHost`、`gui/startCoreWithGui`、服务端 `[internalConfig] screens` 登记对端）+ 启动 deskflow.exe，Deskflow 原有全部功能不受影响

## 已知限制

- Deskflow fork 版 GUI 内置的 C++ 发现弹窗与本插件并存，可能各弹一次协商窗（不影响功能）
- 服务端屏幕登记只写 `name`，其余屏幕选项（修饰键映射、切换角等）走 Deskflow 默认值

## License

[GPL-3.0](./LICENSE) —— 本插件发现协议实现源自 GPL-3.0 项目的 Deskflow fork 源码。
