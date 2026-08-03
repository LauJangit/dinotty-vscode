# Dinotty VS Code

Dinotty VS Code 在 VS Code 中管理多个 Dinotty 连接，并把每个连接打开为原生 Integrated Terminal。扩展只充当客户端：打开连接会调用 `POST /api/tabs` 新建远端 tab/pane；关闭 VS Code terminal 只断开本地 endpoint，不删除远端 tab。

## 兼容性

- VS Code `1.90.0` 或更高版本。
- Dinotty `v0.18.0` 或更高版本；最低要求对应引入 `snapshot_request`、`replay_begin/replay_end` 的提交 `8bcee3186ea900f458ff4cb23bc56804b0bd3ae1`。
- HTTP 和 WebSocket 鉴权使用 `Authorization: Bearer <access-code>`。

## 使用

1. 在 Activity Bar 打开 Dinotty 的 `Connections` 视图。
2. 选择 `Add Connection`，依次填写 HTTP(S) 地址、显示名称和可选 access code。
3. 单击连接项，或从命令面板运行 `Dinotty: Connect`，创建并显示目标 terminal。
4. 也可以在 terminal profile 列表选择 `Dinotty`；存在多个连接时会先显示连接选择器。

连接项右键菜单提供 Connect、Test Connection、Set as Default、Edit 和 Delete。第一条连接自动成为默认项；默认项会在多连接选择器中置顶，但不会绕过用户选择。

工作区的第一个本地 `file:` folder 会作为新 tab 的 cwd。Remote SSH、WSL 和 Container 路径不会自动映射到本机 Dinotty。

## 连接与凭据存储

- 连接名称、规范化地址、顺序和默认项保存在扩展的 `globalStorageUri/connection-store-v1.json`，不会写入 workspace settings。
- access code 只保存在 VS Code `SecretStorage` 的随机 slot；state file、TreeView、terminal title、Output channel 和错误消息都不包含凭据。
- 每个 terminal 在创建时冻结 `{ profileId, name, serverUrl, accessToken }` 快照。之后编辑或删除连接只影响新 terminal，已经打开的 terminal 仍连接原目标。
- profile 声明了 credential slot 但 SecretStorage 中的值缺失时，该 profile 不会降级为无鉴权请求；请通过 Edit 明确 Replace 或 Clear。
- loopback HTTP (`localhost`、`127.0.0.0/8`、`::1`) 可以使用 access code。非 loopback HTTP 会显示明文传输警告，而且不能保存 access code；远端鉴权请使用 HTTPS。

首次升级时，扩展只尝试迁移显式 global `dinotty.serverUrl`，并读取旧固定 secret。URL-only 会迁移为无鉴权连接；token-only、只有 workspace URL 或确定无效的组合不会被猜测绑定到某个地址，而会保留旧值并提示手动添加。成功提交新 store 后，旧 global setting 和 fixed secret 各进行一次 best-effort 清理。

## 多窗口一致性

同一设备、同一 VS Code user profile 下的窗口共享一个连接 state file。实现边界是 best effort：

- 同一 extension host 的操作串行执行；跨窗口写入通过有界 writer lease 减少普通碰撞。
- writer 获得 lease 后会重新读取当前磁盘 envelope，再按 profile id 应用修改。
- state 通过临时文件和 atomic rename 替换，读取方只接受完整、通过 schema/invariant 校验的 envelope。
- 文件 watcher 尽力通知其他窗口；`Refresh Connections` 始终是事件延迟、合并或漏报时的显式重新读取入口。
- 拿不到 lease 时当前写命令返回 busy，不会退化成无锁写入。
- lease 不是 fencing。极端 stale-owner overlap 下允许最后完成的 atomic write 覆盖较早更新，不提供自动 merge、提交 lineage、强线性化或无丢失更新保证。

读取暂时失败但当前窗口已有最后一个有效快照时，Connections 视图进入只读降级：仍可查看和连接已有 profile，但 Add/Edit/Delete 暂时禁用。没有有效快照时只保留 Refresh 和 Show Log。任何后续成功的 direct read、watcher refresh 或手动 Refresh 都会恢复正常状态。

## Terminal 协议与生命周期

- 完整解析 `snapshot_request`、replay、DEC synchronized output、remote resize 和 session exit 协议。
- replay/sync 使用有界嵌套事务；中间帧不会直接写入 VS Code renderer。replay 以 `dimensions override -> RIS + frozen appearance + snapshot` 的顺序一次提交。
- 分开维护 VS Code local capacity 和当前 render geometry。可容纳的远端网格使用 dimensions override；过大的远端网格暂停绘制，并通过新 snapshot 恢复。
- active 且 focused 的 VS Code terminal 在远端 geometry 或本地 resize barrier 下输入时，保证同一 WebSocket 上先发送 `snapshot_request(localCapacity)`，再发送 input。
- transport 临时断开时只重连原 pane，采用 `1s -> 2s -> 4s -> 8s -> 15s -> 30s` 退避，最多 10 次或 5 分钟。鉴权失败、pane 不存在和 authoritative session exit 不重连。
- 创建、连接和重连期间的输入使用有界队列；不会自动重发已经发送的用户输入。
- 状态显示在带连接名称的 terminal title 和 active Dinotty terminal 的状态栏，不向 TUI alternate screen 注入诊断文字。
- terminal close、创建失败、provider 取消和扩展停用都会幂等释放对应 PTY、listener、session 与 snapshot。

## 外观

`dinotty.terminalAppearanceMode` 只影响新建的 Dinotty terminal：

| 值 | 默认 | 行为 |
| --- | --- | --- |
| `native` | 是 | 使用 VS Code terminal theme，不读取 `/api/settings`，不注入 OSC palette |
| `base` | 否 | 冻结创建时读取的前景、背景和光标色，仅注入 OSC 10/11/12 |
| `exact` | 否 | 在 `base` 基础上注入 OSC 4 的 ANSI 0-15 palette |

旧设置 `dinotty.syncAppearanceFromDinotty` 已废弃。只有用户显式配置的 `true` 会映射为 `exact`；显式 `false` 或没有显式值均为 `native`。新 enum 始终优先。

扩展不会修改 `terminal.integrated.*`、`workbench.colorCustomizations` 或任何全局/工作区 terminal font、contrast、theme 设置。

## 已知协议限制

Dinotty 当前多客户端 geometry 也是 best effort：

- `snapshot_request` 引发的全局 PTY resize 当前不会向其他 endpoint 广播；其他客户端可能暂时保留旧网格。
- 普通 `resize` 没有 origin applied acknowledgment，renderer 与 PTY 在服务端 debounce 窗口内可能短暂不一致。
- 不同连接仍是最后一次 resize 生效；`snapshot_request -> input` 只保证同一个 VS Code WebSocket read loop 内的顺序，不能阻止另一个客户端插入 resize。
- VS Code dimensions override 只能缩小逻辑网格，不能显示超过当前 panel capacity 的远端网格。此时扩展会停止增量绘制，等待 panel 扩大或用户输入切回本地尺寸。
- `/api/settings` 是全局设置而非 per-session profile；`base/exact` 只冻结扩展创建 terminal 前读取到的值。

严格多客户端 geometry 一致性需要 Dinotty 服务端协议改造，不属于本扩展当前范围。

## 开发

```powershell
npm install
npm run check
npm run package:vsix
```

常用脚本：

- `npm run typecheck`：检查扩展源码。
- `npm run test:typecheck`：严格检查源码和测试源码。
- `npm run test:unit`：运行不依赖 VS Code runtime 的 Node 单元测试。
- `npm run test:integration`：下载/缓存 VS Code `1.90.0` 并运行 extension-host smoke test。
- `npm run bundle`：生成 production `dist/extension.js`。
- `npm run package:vsix`：执行完整检查并生成 `artifacts/dinotty-vscode.vsix`。

Linux CI 运行 extension-host tests 时需要 `xvfb-run`。发布包采用 allowlist，只包含 manifest、README、LICENSE、`media/` 和同次构建生成的 `dist/`。
