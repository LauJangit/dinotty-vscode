import * as vscode from 'vscode';
import type { TerminalAppearanceMode } from './appearance';
import { resolveTerminalAppearanceMode } from './appearanceConfig';

const SYNC_APPEARANCE_SETTING = 'dinotty.syncAppearanceFromDinotty';
const APPEARANCE_MODE_SETTING = 'dinotty.terminalAppearanceMode';

export function getTerminalAppearanceMode(): TerminalAppearanceMode {
  const configuration = vscode.workspace.getConfiguration();
  return resolveTerminalAppearanceMode(
    configuration.inspect<TerminalAppearanceMode>(APPEARANCE_MODE_SETTING),
    configuration.inspect<boolean>(SYNC_APPEARANCE_SETTING)
  );
}
