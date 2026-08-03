# Dinotty for VS Code

[English](README.md) | [简体中文](README.zh-CN.md)

Dinotty terminals, seamlessly integrated into VS Code.

Dinotty for VS Code brings Dinotty-powered terminal sessions into VS Code's
integrated terminal. Opening a connection creates a new Dinotty tab and pane,
then presents that terminal through the standard VS Code terminal UI with
replay-aware rendering, geometry synchronization, and automatic reconnection.

> [!IMPORTANT]
> This extension is a terminal client for Dinotty, not a full Dinotty
> administration interface. It does not browse or manage existing tabs and
> panes. The **Connections** view stores local server profiles used to open new
> terminals.

## Features

- **Integrated terminal experience** - Open Dinotty from the Activity Bar,
  Command Palette, or VS Code terminal profile menu.
- **Multiple server profiles** - Save, test, edit, and select Dinotty
  endpoints without putting credentials in workspace settings.
- **Secure credentials** - Access codes are stored in VS Code SecretStorage and
  are redacted from titles, logs, state files, and error messages.
- **Reliable terminal rendering** - Snapshot replay and synchronized output are
  committed atomically so partial frames are not shown in the terminal.
- **Responsive terminal sizing** - Remote geometry is coordinated with the
  current VS Code panel, including recovery when the remote terminal is larger
  than the available space.
- **Resilient sessions** - Temporary WebSocket failures reconnect to the same
  Dinotty pane with bounded exponential backoff.
- **Optional appearance sync** - Use the native VS Code theme or import base and
  ANSI colors from Dinotty for each newly opened terminal.

## Requirements

- VS Code `1.90.0` or newer.
- Dinotty `v0.18.0` or newer.
- A reachable Dinotty HTTP(S) endpoint.

The minimum Dinotty version must include `snapshot_request` and
`replay_begin`/`replay_end` support, introduced by Dinotty commit
`8bcee3186ea900f458ff4cb23bc56804b0bd3ae1`.

## Installation

Install a published `.vsix` with the VS Code command:

1. Open the Command Palette.
2. Run **Extensions: Install from VSIX...**.
3. Select the Dinotty VSIX file and reload VS Code when prompted.

To build a VSIX from source:

```powershell
npm ci
npm run package:vsix
```

The package is written to `artifacts/dinotty-vscode.vsix`.

## Quick Start

1. Select the Dinotty icon in the Activity Bar.
2. Choose **Add Dinotty Connection**.
3. Enter the Dinotty server URL, a local display name, and an optional access
   code.
4. Select the saved profile in the **Connections** view.
5. Use the newly created terminal like any other VS Code integrated terminal.

You can also run **Dinotty: Connect** from the Command Palette or select
**Dinotty** from the terminal profile menu. When more than one profile exists,
the extension asks which server to use.

## What Happens When You Open a Terminal

The extension performs the following sequence for every new terminal:

1. Resolves a snapshot of the selected local connection profile.
2. Optionally reads Dinotty appearance settings.
3. Calls `POST /api/tabs` to create a new Dinotty tab and pane.
4. Connects to that pane through `/ws?paneId=...`.
5. Requests and renders a terminal snapshot at a compatible size.
6. Forwards subsequent terminal input, output, and resize events.

Closing the VS Code terminal disconnects its local WebSocket endpoint. It does
not delete the Dinotty tab created on the server. Editing or deleting a saved
profile also does not retarget terminals that are already open.

When a local filesystem workspace is open, its first folder is used as the
working directory for the new Dinotty tab. Remote SSH, WSL, and Dev Container
paths are not translated into paths on the machine running Dinotty.

## Connection Profiles and Security

Connection profiles are local client configuration, not Dinotty server
resources. A profile contains a display name, normalized server URL, ordering
metadata, and an optional reference to a credential.

- Profile metadata is stored in
  `globalStorageUri/connection-store-v1.json`.
- Access codes are stored only in VS Code SecretStorage under randomized slots.
- A terminal freezes its resolved profile when it is created. Later profile
  edits affect only new terminals.
- A missing referenced secret is treated as an error; the extension never
  silently retries the profile without authentication.
- Access codes can be used over HTTP and HTTPS. Non-loopback plain HTTP requires
  an explicit warning because credentials and terminal traffic are unencrypted;
  use HTTPS for remote servers whenever possible.
- HTTP and WebSocket authentication use `Authorization: Bearer <access-code>`.

Profiles are shared by VS Code windows using the same user profile. Writes use
an atomic state file and a bounded writer lease. Cross-window consistency is
best effort rather than a distributed transaction: in an extreme stale-writer
overlap, the last completed atomic write can win.

## Terminal Behavior

### Rendering and replay

The extension understands Dinotty output, resize, reconnect, replay,
synchronized-output, shell-info, and session-exit messages. Replay and nested
synchronized output are buffered and committed as one frame so intermediate
terminal states are not displayed.

### Geometry

VS Code panel capacity and Dinotty render geometry are tracked independently.
A remote grid that fits can be displayed with a dimensions override. If an
active, focused terminal receives an oversized remote grid, the extension asks
Dinotty for a new snapshot at the local size. An inactive terminal pauses
incremental rendering until it is activated, enlarged, or receives input.

### Reconnection

Temporary transport failures reconnect to the original pane after
`1s`, `2s`, `4s`, `8s`, `15s`, and then `30s`. Retries stop after 10 attempts
or 5 minutes. Authentication failures, missing panes, and authoritative session
exits do not reconnect.

Input entered while a terminal is being created, connected, or reconnected is
held in a bounded queue. Input that was already sent is never replayed
automatically.

## Appearance

Set `dinotty.terminalAppearanceMode` to control the appearance of newly opened
Dinotty terminals:

| Value | Default | Behavior |
| --- | --- | --- |
| `native` | Yes | Use the VS Code terminal theme and do not request Dinotty colors. |
| `base` | No | Apply Dinotty foreground, background, and cursor colors. |
| `exact` | No | Apply base colors and the Dinotty ANSI 0-15 palette. |

The extension does not modify `terminal.integrated.*`,
`workbench.colorCustomizations`, terminal fonts, contrast settings, or the
global VS Code theme.

The legacy `dinotty.syncAppearanceFromDinotty` setting is deprecated. An
explicit `true` maps to `exact`, while `false` maps to `native`. The new setting
always takes precedence.

## Commands

| Command | Purpose |
| --- | --- |
| `Dinotty: Add Connection` | Save a local Dinotty server profile. |
| `Dinotty: Connect` | Choose a profile and open a new Dinotty terminal. |
| `Connect` | Open the selected profile from the Connections view. |
| `Test Connection` | Validate HTTP reachability and authentication. |
| `Set as Default` | Mark the profile shown first in the connection picker. |
| `Edit Connection` | Update a profile or replace/clear its access code. |
| `Delete Connection` | Remove a local profile without affecting open terminals. |
| `Dinotty: Refresh Connections` | Reload shared profile state from disk. |
| `Dinotty: Show Log` | Open the redacted Dinotty output channel. |

## Known Limitations

- The extension creates a new Dinotty tab and pane for every terminal; it does
  not list, reopen, rename, split, or delete existing Dinotty resources.
- Closing a VS Code terminal does not delete its remote Dinotty tab.
- Remote workspace paths are not mapped to the Dinotty host.
- Dinotty geometry is shared across clients on a last-resize-wins basis.
  `snapshot_request` and resize events cannot provide strict multi-client
  geometry consistency without additional server protocol support.
- Appearance settings are global Dinotty settings, not per-session values, and
  are frozen when a terminal is created.

## Troubleshooting

- Run **Dinotty: Test Connection** to check the selected URL and access code.
- Open **Dinotty: Show Log** for redacted connection and protocol diagnostics.
- If authentication fails, edit the profile and explicitly replace or clear
  its saved access code.
- If shared profile storage becomes temporarily unavailable, the Connections
  view can continue using its last valid snapshot in read-only mode. Run
  **Dinotty: Refresh Connections** after resolving the storage problem.

## Development

```powershell
npm ci
npm run check
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check the extension source. |
| `npm run test:typecheck` | Type-check source and test projects. |
| `npm run test:unit` | Run Node-based unit tests. |
| `npm run test:integration` | Run the VS Code extension-host smoke test. |
| `npm run bundle` | Build `dist/extension.js` for production. |
| `npm run package:vsix` | Run all checks and create the VSIX package. |

The integration test downloads or reuses VS Code `1.90.0`. Linux CI requires
`xvfb-run` for extension-host tests. The VSIX uses an allowlist and contains
only the manifest, README, license, media assets, and the generated production
bundle.

## License

MIT
