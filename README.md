# Dinotty VS Code

Dinotty VS Code 在 VS Code 中提供一个原生 Integrated Terminal profile，并连接到 Dinotty 创建的 pane/TTY。扩展只充当客户端：关闭 VS Code terminal 只会断开本地 endpoint，不会删除 Dinotty tab。

## 兼容性

- VS Code `1.90.0` 或更高版本。
- Dinotty `v0.18.0` 或更高版本；最低要求对应引入 `snapshot_request`、`replay_begin/replay_end` 的提交 `8bcee3186ea900f458ff4cb23bc56804b0bd3ae1`。
- HTTP 和 WebSocket 鉴权使用 `Authorization: Bearer <token>`；token 只存放在 VS Code `SecretStorage`，不会出现在 URL 或日志中。

## 使用

1. 执行 `Dinotty: Configure Server`，填写 Dinotty HTTP(S) 地址和可选 access token。
2. 在终端 profile 列表选择 `Dinotty`。
3. 扩展创建一个新 Dinotty tab，并在获得 VS Code 最终行列数后执行 `reconnected -> snapshot_request -> replay` 握手。

工作区的第一个本地 `file:` folder 会作为新 tab 的 cwd。Remote SSH、WSL 和 Container 路径不会自动映射到本机 Dinotty。

## 阶段一能力

- 完整解析 `snapshot_request`、replay、DEC synchronized output、remote resize 和 session exit 协议。
- replay/sync 使用有界嵌套事务；中间帧不会直接写入 VS Code renderer。replay 以 `dimensions override -> RIS + frozen appearance + snapshot` 的顺序一次提交。
- 分开维护 VS Code local capacity 和当前 render geometry。可容纳的远端网格使用 dimensions override；过大的远端网格暂停绘制，并通过新 snapshot 恢复。
- active 且 focused 的 VS Code terminal 在远端 geometry 或本地 resize barrier 下输入时，保证同一 WebSocket 上先发送 `snapshot_request(localCapacity)`，再发送 input。
- transport 临时断开时只重连原 pane，采用 `1s -> 2s -> 4s -> 8s -> 15s -> 30s` 退避，最多 10 次或 5 分钟。鉴权失败、pane 不存在和 authoritative session exit 不重连。
- 创建、连接和重连期间的输入使用有界队列；不会自动重发已经发送的用户输入。
- 状态显示在 terminal name 和 active Dinotty terminal 的状态栏，不向 TUI alternate screen 注入诊断文字。

## 外观

`dinotty.terminalAppearanceMode` 只影响新建的 Dinotty terminal：

| 值 | 默认 | 行为 |
| --- | --- | --- |
| `native` | 是 | 使用 VS Code terminal theme，不读取 `/api/settings`，不注入 OSC palette |
| `base` | 否 | 冻结创建时读取的前景、背景和光标色，仅注入 OSC 10/11/12 |
| `exact` | 否 | 在 `base` 基础上注入 OSC 4 的 ANSI 0-15 palette |

旧设置 `dinotty.syncAppearanceFromDinotty` 已废弃。只有用户显式配置的 `true` 会迁移为 `exact`；显式 `false` 或没有显式值均为 `native`。新 enum 始终优先。

扩展不会修改 `terminal.integrated.*`、`workbench.colorCustomizations` 或任何全局/工作区 terminal font、contrast、theme 设置。

## 当前多客户端限制

阶段一只适配现有 Dinotty 协议，因此多客户端 geometry 是 best-effort，而不是强一致：

- `snapshot_request` 引发的全局 PTY resize 当前不会向其他 endpoint 广播；其他客户端可能暂时保留旧网格。
- 普通 `resize` 没有 origin applied acknowledgment，renderer 与 PTY 在服务端 debounce 窗口内可能短暂不一致。
- 不同连接仍是最后一次 resize 生效；`snapshot_request -> input` 只保证同一个 VS Code WebSocket read loop 内的顺序，不能阻止另一个客户端插入 resize。
- VS Code dimensions override 只能缩小逻辑网格，不能显示超过当前 panel capacity 的远端网格。此时扩展会停止增量绘制，等待 panel 扩大或用户输入切回本地尺寸。
- `/api/settings` 是全局设置而非 per-session profile；`base/exact` 只冻结扩展创建 terminal 前读取到的值。

严格多客户端 geometry 一致性需要 Dinotty 服务端阶段二改造，不属于本扩展阶段一。

## 生命周期与安全

- 用户关闭 VS Code terminal：abort 请求、清理 timer、关闭本地 WebSocket；不调用远端删除 API。
- Dinotty 发送顶层或 output sentinel `session_exit`：结束本地 terminal，不创建替代 session。
- 未知消息只记录 type 名；日志不记录 raw output、input、token、Authorization header 或创建者 cwd。
- `POST /api/tabs` 没有 cwd 时发送 `{}`；WebSocket URL 只包含 URL-encoded `paneId`。

## 开发

```powershell
npm install
npm run typecheck
npm test
npm run package
```

`npm run check` 会依次执行 typecheck、自动化测试和 production bundle。VS Code 实际加载 `dist/extension.js`，发布前必须运行 package，不能手工编辑 bundle。

自动化测试覆盖协议 parser、非法 geometry、session-exit sentinel、初次 snapshot handshake、嵌套 replay/sync、geometry suspend/resume、输入 barrier wire order、appearance 模式和旧设置迁移。
