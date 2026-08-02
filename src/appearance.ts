export interface DinottySettings {
  theme?: {
    preset?: string;
    custom?: {
      foreground?: string | null;
      background?: string | null;
      cursor?: string | null;
      ansi?: Array<string | null | undefined> | null;
    } | null;
  };
  background?: {
    color?: string | null;
  };
}

interface XtermColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type TerminalAppearanceMode = 'native' | 'base' | 'exact';

export interface LocalTerminalAppearance {
  readonly mode: TerminalAppearanceMode;
  readonly osc: string;
}

const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const;

const BUILTIN_THEMES: Record<string, XtermColors> = {
  dark: {
    background: '#1E1E1E',
    foreground: '#CCCCCC',
    cursor: '#858585',
    cursorAccent: '#000000',
    black: '#000000',
    red: '#F44747',
    green: '#6A9955',
    yellow: '#D7BA7D',
    blue: '#569CD6',
    magenta: '#C586C0',
    cyan: '#4EC9B0',
    white: '#D4D4D4',
    brightBlack: '#808080',
    brightRed: '#F14C4C',
    brightGreen: '#73C991',
    brightYellow: '#CCA700',
    brightBlue: '#6796E6',
    brightMagenta: '#D670D6',
    brightCyan: '#23D18B',
    brightWhite: '#FFFFFF'
  },
  light: {
    background: '#FFFFFF',
    foreground: '#333333',
    cursor: '#999999',
    cursorAccent: '#000000',
    black: '#000000',
    red: '#C91B00',
    green: '#00A600',
    yellow: '#999900',
    blue: '#0000B2',
    magenta: '#B200B2',
    cyan: '#00A6B2',
    white: '#BFBFBF',
    brightBlack: '#666666',
    brightRed: '#E50000',
    brightGreen: '#00D900',
    brightYellow: '#E5E500',
    brightBlue: '#0000FF',
    brightMagenta: '#E500E5',
    brightCyan: '#00E5E5',
    brightWhite: '#E5E5E5'
  },
  dracula: {
    background: '#282A36',
    foreground: '#F8F8F2',
    cursor: '#6272A4',
    cursorAccent: '#21222C',
    black: '#21222C',
    red: '#FF5555',
    green: '#50FA7B',
    yellow: '#F1FA8C',
    blue: '#BD93F9',
    magenta: '#FF79C6',
    cyan: '#8BE9FD',
    white: '#F8F8F2',
    brightBlack: '#6272A4',
    brightRed: '#FF6E6E',
    brightGreen: '#69FF94',
    brightYellow: '#FFFFA5',
    brightBlue: '#D6ACFF',
    brightMagenta: '#FF92DF',
    brightCyan: '#A4FFFF',
    brightWhite: '#FFFFFF'
  },
  nord: {
    background: '#2E3440',
    foreground: '#D8DEE9',
    cursor: '#4C566A',
    cursorAccent: '#3B4252',
    black: '#3B4252',
    red: '#BF616A',
    green: '#A3BE8C',
    yellow: '#EBCB8B',
    blue: '#81A1C1',
    magenta: '#B48EAD',
    cyan: '#88C0D0',
    white: '#E5E9F0',
    brightBlack: '#4C566A',
    brightRed: '#BF616A',
    brightGreen: '#A3BE8C',
    brightYellow: '#EBCB8B',
    brightBlue: '#81A1C1',
    brightMagenta: '#B48EAD',
    brightCyan: '#8FBCBB',
    brightWhite: '#ECEFF4'
  },
  monokai: {
    background: '#272822',
    foreground: '#F8F8F2',
    cursor: '#75715E',
    cursorAccent: '#272822',
    black: '#272822',
    red: '#F92672',
    green: '#A6E22E',
    yellow: '#F4BF75',
    blue: '#66D9EF',
    magenta: '#AE81FF',
    cyan: '#A1EFE4',
    white: '#F8F8F2',
    brightBlack: '#75715E',
    brightRed: '#F92672',
    brightGreen: '#A6E22E',
    brightYellow: '#F4BF75',
    brightBlue: '#66D9EF',
    brightMagenta: '#AE81FF',
    brightCyan: '#A1EFE4',
    brightWhite: '#F9F8F5'
  },
  solarized: {
    background: '#002B36',
    foreground: '#839496',
    cursor: '#586E75',
    cursorAccent: '#073642',
    black: '#073642',
    red: '#DC322F',
    green: '#859900',
    yellow: '#B58900',
    blue: '#268BD2',
    magenta: '#D33682',
    cyan: '#2AA198',
    white: '#EEE8D5',
    brightBlack: '#586E75',
    brightRed: '#CB4B16',
    brightGreen: '#859900',
    brightYellow: '#B58900',
    brightBlue: '#268BD2',
    brightMagenta: '#6C71C4',
    brightCyan: '#2AA198',
    brightWhite: '#FDF6E3'
  },
  catppuccin: {
    background: '#1E1E2E',
    foreground: '#CDD6F4',
    cursor: '#6C7086',
    cursorAccent: '#45475A',
    black: '#45475A',
    red: '#F38BA8',
    green: '#A6E3A1',
    yellow: '#F9E2AF',
    blue: '#89B4FA',
    magenta: '#F5C2E7',
    cyan: '#94E2D5',
    white: '#BAC2DE',
    brightBlack: '#585B70',
    brightRed: '#F38BA8',
    brightGreen: '#A6E3A1',
    brightYellow: '#F9E2AF',
    brightBlue: '#89B4FA',
    brightMagenta: '#F5C2E7',
    brightCyan: '#94E2D5',
    brightWhite: '#A6ADC8'
  },
  gruvbox: {
    background: '#282828',
    foreground: '#EBDBB2',
    cursor: '#928374',
    cursorAccent: '#282828',
    black: '#282828',
    red: '#CC241D',
    green: '#98971A',
    yellow: '#D79921',
    blue: '#458588',
    magenta: '#B16286',
    cyan: '#689D6A',
    white: '#A89984',
    brightBlack: '#928374',
    brightRed: '#FB4934',
    brightGreen: '#B8BB26',
    brightYellow: '#FABD2F',
    brightBlue: '#83A598',
    brightMagenta: '#D3869B',
    brightCyan: '#8EC07C',
    brightWhite: '#EBDBB2'
  },
  tokyonight: {
    background: '#1A1B26',
    foreground: '#C0CAF5',
    cursor: '#565F89',
    cursorAccent: '#15161E',
    black: '#15161E',
    red: '#F7768E',
    green: '#9ECE6A',
    yellow: '#E0AF68',
    blue: '#7AA2F7',
    magenta: '#BB9AF7',
    cyan: '#7DCFFF',
    white: '#A9B1D6',
    brightBlack: '#414868',
    brightRed: '#F7768E',
    brightGreen: '#9ECE6A',
    brightYellow: '#E0AF68',
    brightBlue: '#7AA2F7',
    brightMagenta: '#BB9AF7',
    brightCyan: '#7DCFFF',
    brightWhite: '#C0CAF5'
  },
  onedark: {
    background: '#282C34',
    foreground: '#ABB2BF',
    cursor: '#545862',
    cursorAccent: '#282C34',
    black: '#282C34',
    red: '#E06C75',
    green: '#98C379',
    yellow: '#E5C07B',
    blue: '#61AFEF',
    magenta: '#C678DD',
    cyan: '#56B6C2',
    white: '#ABB2BF',
    brightBlack: '#545862',
    brightRed: '#E06C75',
    brightGreen: '#98C379',
    brightYellow: '#E5C07B',
    brightBlue: '#61AFEF',
    brightMagenta: '#C678DD',
    brightCyan: '#56B6C2',
    brightWhite: '#C8CCD4'
  },
  palenight: {
    background: '#292D3E',
    foreground: '#A6ACCD',
    cursor: '#676E95',
    cursorAccent: '#292D3E',
    black: '#292D3E',
    red: '#F07178',
    green: '#C3E88D',
    yellow: '#FFCB6B',
    blue: '#82AAFF',
    magenta: '#C792EA',
    cyan: '#89DDFF',
    white: '#A6ACCD',
    brightBlack: '#676E95',
    brightRed: '#F07178',
    brightGreen: '#C3E88D',
    brightYellow: '#FFCB6B',
    brightBlue: '#82AAFF',
    brightMagenta: '#C792EA',
    brightCyan: '#89DDFF',
    brightWhite: '#D1D5DE'
  },
  ayudark: {
    background: '#0B0E14',
    foreground: '#BFBDB6',
    cursor: '#4D5566',
    cursorAccent: '#0B0E14',
    black: '#0B0E14',
    red: '#FF3333',
    green: '#C2D94C',
    yellow: '#E6B450',
    blue: '#39BAE6',
    magenta: '#F07178',
    cyan: '#95E6CB',
    white: '#BFBDB6',
    brightBlack: '#4D5566',
    brightRed: '#FF6B6B',
    brightGreen: '#D4E657',
    brightYellow: '#FFD173',
    brightBlue: '#59C2FF',
    brightMagenta: '#F28779',
    brightCyan: '#95E6CB',
    brightWhite: '#CBCCC6'
  }
};

export function resolveLocalTerminalAppearance(
  mode: TerminalAppearanceMode,
  settings?: DinottySettings
): LocalTerminalAppearance {
  if (mode === 'native' || !settings) {
    return Object.freeze({ mode: 'native', osc: '' });
  }

  const preset = settings.theme?.preset ?? 'dark';
  const resolved: XtermColors = { ...(BUILTIN_THEMES[preset] ?? BUILTIN_THEMES.dark) };
  const custom = settings.theme?.custom;

  const customForeground = normalizeHexColor(custom?.foreground);
  if (customForeground) {
    resolved.foreground = customForeground;
  }

  const customBackground = normalizeHexColor(custom?.background);
  if (customBackground) {
    resolved.background = customBackground;
  }

  const customCursor = normalizeHexColor(custom?.cursor);
  if (customCursor) {
    resolved.cursor = customCursor;
  }

  if (Array.isArray(custom?.ansi)) {
    custom.ansi.forEach((value, index) => {
      const key = ANSI_COLOR_KEYS[index];
      const color = normalizeHexColor(value);
      if (key && color) {
        resolved[key] = color;
      }
    });
  }

  // Dinotty applies background.color after theme.custom.background in the DOM.
  const backgroundColor = normalizeHexColor(settings.background?.color);
  if (backgroundColor) {
    resolved.background = backgroundColor;
  }

  const baseOsc = [
    osc(`10;${resolved.foreground}`),
    osc(`11;${resolved.background}`),
    osc(`12;${resolved.cursor}`)
  ].join('');
  return Object.freeze({
    mode,
    osc: mode === 'exact' ? `${baseOsc}${buildAnsiPaletteOsc(resolved)}` : baseOsc
  });
}

/** @deprecated Use resolveLocalTerminalAppearance with an explicit mode. */
export function buildDinottyAppearanceOsc(settings: DinottySettings): string {
  return resolveLocalTerminalAppearance('exact', settings).osc;
}

function buildAnsiPaletteOsc(colors: XtermColors): string {
  const parts = ANSI_COLOR_KEYS.flatMap((key, index) => [String(index), colors[key]]);
  return osc(`4;${parts.join(';')}`);
}

function osc(command: string): string {
  return `\x1b]${command}\x07`;
}

export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  const shortMatch = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (shortMatch) {
    return `#${shortMatch[1]
      .split('')
      .map((char) => `${char}${char}`)
      .join('')
      .toUpperCase()}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return undefined;
}
