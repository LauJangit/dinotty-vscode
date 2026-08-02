import type { TerminalAppearanceMode } from './appearance';

export interface ConfigurationInspection<T> {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  globalLanguageValue?: T;
  workspaceLanguageValue?: T;
  workspaceFolderLanguageValue?: T;
}

export function resolveTerminalAppearanceMode(
  modeInspection: ConfigurationInspection<TerminalAppearanceMode> | undefined,
  legacyInspection: ConfigurationInspection<boolean> | undefined
): TerminalAppearanceMode {
  const explicitMode = explicitConfigurationValue(modeInspection);
  if (explicitMode === 'native' || explicitMode === 'base' || explicitMode === 'exact') {
    return explicitMode;
  }
  return explicitConfigurationValue(legacyInspection) === true ? 'exact' : 'native';
}

function explicitConfigurationValue<T>(inspection: ConfigurationInspection<T> | undefined): T | undefined {
  return inspection?.workspaceFolderLanguageValue ?? inspection?.workspaceLanguageValue ?? inspection?.globalLanguageValue ??
    inspection?.workspaceFolderValue ?? inspection?.workspaceValue ?? inspection?.globalValue;
}
