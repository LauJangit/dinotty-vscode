# Dinotty for VS Code

[English](README.md) | 简体中文

让 Dinotty 终端无缝融入 VS Code。

Dinotty for VS Code 将 Dinotty 终端会话带入 VS Code 集成终端。打开连接时，
扩展会新建一个 Dinotty tab 和 pane，并通过 VS Code 标准终端界面呈现，同时处理
快照回放、终端尺寸协调和自动重连。

> [!IMPORTANT]
> 本扩展是 Dinotty 的终端客户端，而不是完整的 Dinotty 管理界面。它不会浏览或
> 管理已有的 tab 和 pane。**Connections** 视图保存的是用于打开新终端的本地
> 服务器配置。

## 功能特性

- **集成终端体验** - 可以从 Activity Bar、命令面板或 VS Code 终端配置菜单打开
  Dinotty。
- **多个服务器配置** - 保存、测试、编辑和选择 Dinotty 服务端地址，无需把凭据
  写入工作区设置。
- **安全的凭据存储** - access code 保存在 VS Code SecretStorage 中，并从终端标题、
  日志、状态文件和错误消息中移除。
- **可靠的终端渲染** - 快照回放和同步输出会以完整帧提交，不会把中间状态显示在
  终端中。
- **自适应终端尺寸** - 协调远端终端尺寸与当前 VS Code 面板空间，并能在远端尺寸
  过大时自动恢复。
- **可靠的会话连接** - WebSocket 暂时中断时，会使用有界指数退避重新连接到同一个
  Dinotty pane。
- **可选的外观同步** - 可以使用 VS Code 原生主题，也可以为新终端读取 Dinotty
  基础色和 ANSI 调色板。

## 环境要求

- VS Code `1.90.0` 或更高版本。
- Dinotty `v0.18.0` 或更高版本。
- 可以访问的 Dinotty HTTP(S) 服务端地址。

最低 Dinotty 版本必须支持 `snapshot_request` 和
`replay_begin`/`replay_end`。这些能力由 Dinotty 提交
`8bcee3186ea900f458ff4cb23bc56804b0bd3ae1` 引入。

## 安装

使用 VS Code 安装已发布的 `.vsix`：

1. 打开命令面板。
2. 运行 **Extensions: Install from VSIX...**。
3. 选择 Dinotty VSIX 文件，并在提示后重新加载 VS Code。

从源码构建 VSIX：

```powershell
npm ci
npm run package:vsix
```

生成的安装包位于 `artifacts/dinotty-vscode.vsix`。

## 快速开始

1. 在 Activity Bar 中选择 Dinotty 图标。
2. 选择 **Add Dinotty Connection**。
3. 输入 Dinotty 服务端 URL、本地显示名称和可选的 access code。
4. 在 **Connections** 视图中选择保存的配置。
5. 像使用其他 VS Code 集成终端一样使用新建的终端。

也可以从命令面板运行 **Dinotty: Connect**，或者从终端配置菜单选择
**Dinotty**。存在多个配置时，扩展会询问要使用哪个服务端。

## 打开终端时会发生什么

扩展会为每个新终端依次执行以下操作：

1. 解析所选本地连接配置的固定快照。
2. 根据设置读取 Dinotty 外观配置。
3. 调用 `POST /api/tabs` 新建 Dinotty tab 和 pane。
4. 通过 `/ws?paneId=...` 连接到该 pane。
5. 按照兼容的终端尺寸请求并渲染快照。
6. 转发后续的终端输入、输出和尺寸变化事件。

关闭 VS Code 终端只会断开本地 WebSocket endpoint，不会删除服务端新建的
Dinotty tab。编辑或删除本地连接配置，也不会改变已经打开的终端目标。

当工作区包含本地文件系统目录时，第一个目录会作为新 Dinotty tab 的工作目录。
Remote SSH、WSL 和 Dev Container 路径不会被转换成运行 Dinotty 的主机路径。

## 连接配置与安全

连接配置是本地客户端设置，不是 Dinotty 服务端资源。每个配置包含显示名称、
规范化的服务端 URL、顺序信息，以及一个可选的凭据引用。

- 配置元数据保存在 `globalStorageUri/connection-store-v1.json`。
- access code 只保存在 VS Code SecretStorage 的随机 slot 中。
- 新建终端时会固定当时解析出的连接配置，后续编辑只影响新终端。
- 如果配置引用的 secret 丢失，扩展会直接报错，不会静默改成无鉴权请求。
- access code 可以通过 HTTP 或 HTTPS 使用。非 loopback 明文 HTTP 会先显示明确
  警告，因为凭据和终端流量均未加密；远端服务应尽可能使用 HTTPS。
- HTTP 和 WebSocket 鉴权使用 `Authorization: Bearer <access-code>`。

使用同一个 VS Code user profile 的多个窗口会共享连接配置。状态文件采用原子写入
并使用有界 writer lease。跨窗口一致性属于 best effort，而不是分布式事务：在极端
的 stale-writer 重叠情况下，最后完成的原子写入可能覆盖之前的修改。

## 终端行为

### 渲染与回放

扩展能够处理 Dinotty 的 output、resize、reconnect、replay、同步输出、shell info
和 session exit 消息。replay 和嵌套的同步输出会先缓冲，再作为一个完整帧提交，
避免显示不完整的终端状态。

### 终端尺寸

VS Code 面板容量和 Dinotty 渲染尺寸会被分别维护。能够容纳的远端网格会通过
dimensions override 显示。如果 active 且 focused 的终端收到过大的远端网格，
扩展会要求 Dinotty 按本地尺寸重新生成快照。非活动终端会暂停增量渲染，直到它被
激活、面板扩大或收到用户输入。

### 自动重连

临时传输故障会按照 `1s`、`2s`、`4s`、`8s`、`15s`，之后 `30s` 的间隔重新连接
原来的 pane。达到 10 次或持续 5 分钟后停止重试。鉴权失败、pane 不存在以及服务端
明确发出的 session exit 不会重连。

在终端创建、连接或重连期间输入的内容会进入有界队列。已经发送过的输入不会被
自动重放。

## 外观

通过 `dinotty.terminalAppearanceMode` 控制新建 Dinotty 终端的外观：

| 值 | 默认 | 行为 |
| --- | --- | --- |
| `native` | 是 | 使用 VS Code 终端主题，不请求 Dinotty 颜色。 |
| `base` | 否 | 应用 Dinotty 前景色、背景色和光标颜色。 |
| `exact` | 否 | 在基础颜色之外应用 Dinotty ANSI 0-15 调色板。 |

扩展不会修改 `terminal.integrated.*`、`workbench.colorCustomizations`、终端字体、
对比度设置或 VS Code 全局主题。

旧设置 `dinotty.syncAppearanceFromDinotty` 已废弃。显式设置为 `true` 时映射到
`exact`，设置为 `false` 时映射到 `native`。新设置始终优先。

## 命令

| 命令 | 用途 |
| --- | --- |
| `Dinotty: Add Connection` | 保存本地 Dinotty 服务端配置。 |
| `Dinotty: Connect` | 选择配置并打开新的 Dinotty 终端。 |
| `Connect` | 从 Connections 视图打开所选配置。 |
| `Test Connection` | 检查 HTTP 连通性和鉴权信息。 |
| `Set as Default` | 将该配置置于连接选择器首位。 |
| `Edit Connection` | 更新配置，或者替换/清除 access code。 |
| `Delete Connection` | 删除本地配置，不影响已打开的终端。 |
| `Dinotty: Refresh Connections` | 从磁盘重新加载共享配置状态。 |
| `Dinotty: Show Log` | 打开已经移除敏感信息的 Dinotty output channel。 |

## 已知限制

- 每个终端都会新建 Dinotty tab 和 pane；扩展不会列出、重新打开、重命名、拆分或
  删除已有的 Dinotty 资源。
- 关闭 VS Code 终端不会删除对应的远端 Dinotty tab。
- 远程工作区路径不会映射到 Dinotty 主机。
- 多个客户端之间的 Dinotty geometry 采用最后一次 resize 生效的方式。在服务端
  协议提供更多能力之前，`snapshot_request` 和 resize 事件无法保证严格的多客户端
  尺寸一致性。
- 外观配置来自 Dinotty 全局设置，而不是 per-session 设置，并且会在终端创建时固定。

## 故障排查

- 运行 **Dinotty: Test Connection** 检查所选 URL 和 access code。
- 打开 **Dinotty: Show Log** 查看已经移除敏感信息的连接与协议诊断。
- 如果鉴权失败，请编辑连接配置并明确替换或清除已保存的 access code。
- 如果共享配置存储暂时不可用，Connections 视图可以使用最后一个有效快照进入只读
  模式。解决存储问题后运行 **Dinotty: Refresh Connections**。

## 开发

```powershell
npm ci
npm run check
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查扩展源码类型。 |
| `npm run test:typecheck` | 检查源码和测试项目类型。 |
| `npm run test:unit` | 运行基于 Node 的单元测试。 |
| `npm run test:integration` | 运行 VS Code extension-host smoke test。 |
| `npm run bundle` | 构建生产环境的 `dist/extension.js`。 |
| `npm run package:vsix` | 运行全部检查并创建 VSIX 安装包。 |

集成测试会下载或复用 VS Code `1.90.0`。Linux CI 运行 extension-host 测试时需要
`xvfb-run`。VSIX 使用 allowlist，只包含 manifest、README、license、媒体资源和
生成的生产 bundle。

## 许可证

MIT
