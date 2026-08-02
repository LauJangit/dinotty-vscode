import * as vscode from 'vscode';

export function getWorkspaceCwd(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
}
