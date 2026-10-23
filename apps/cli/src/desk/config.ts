/**
 * desk의 설정 파일(desk.json)과 배치 기억(desk-state.json, #874). 둘 다 `$XDG_CONFIG_HOME/b-studio`(없으면 `~/.config/b-studio`)에 둔다.
 * 설정의 잘못된 값은 기본값으로 두고 무엇이 틀렸는지 돌려준다(desk가 아래 줄에 알린다). 배치는 깨졌으면 버린다
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { PaneLayout } from './screen';
import type { GraphicsSetting } from './kitty';
import { THEMES, type ThemeName } from './theme';

/** 앞글쇠: 받는 글자와 화면에 보일 이름(늘 `Ctrl-x` 꼴이라 안내 글의 폭이 바뀌지 않는다) */
export interface DeskPrefix {
  key: string;
  label: string;
}

export type ColorSetting = 'auto' | 'truecolor' | '256';

export interface DeskConfig {
  prefix?: DeskPrefix;
  notify?: boolean;
  mouse?: boolean;
  color?: ColorSetting;
  /** 색 팔레트(#887): dark(기본)·light */
  theme?: ThemeName;
  /** 카드 그림을 고르는 법(#902): random(기본, 이름 붙인 그림이 없으면 그림 폴더에서 세션마다 무작위)·named(이름 붙인 그림만)·off(기본 그림만) */
  sprites?: SpriteSetting;
  /** 움짤을 움직일지(기본 켬) */
  animate?: boolean;
  /** 그림을 그리는 법: auto(기본, Ghostty·kitty면 Kitty 그래픽)·kitty·blocks(반칸 블록) */
  graphics?: GraphicsSetting;
}

export type SpriteSetting = 'random' | 'named' | 'off';

/** 되살릴 배치. slots는 칸 자리마다의 세션 id다 */
export interface DeskLayout {
  layout: PaneLayout;
  slots: Array<string | undefined>;
  focus: number;
  zoom: boolean;
  sidebarHidden: boolean;
}

const CONFIG_FILE = 'desk.json';
const LAYOUT_FILE = 'desk-state.json';
const SLOT_COUNT = 4;
/** 터미널이 다른 키와 같은 글자로 보내는 Ctrl 글쇠: c(끊기), h(지우기), i(Tab), j(줄바꿈), m(Enter) */
const RESERVED = new Set(['c', 'h', 'i', 'j', 'm']);
const COLORS: readonly ColorSetting[] = ['auto', 'truecolor', '256'];
const SPRITE_SETTINGS: readonly SpriteSetting[] = ['random', 'named', 'off'];
const GRAPHICS: readonly GraphicsSetting[] = ['auto', 'kitty', 'blocks'];

export function deskConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  // XDG 명세는 상대 경로를 무시하라고 한다
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME || homedir(), '.config');
  return join(base, 'b-studio');
}

/** "C-a", "Ctrl-a", "ctrl+A" 꼴의 앞글쇠. 받지 않는 글쇠면 undefined */
export function parsePrefix(text: string): DeskPrefix | undefined {
  const match = /^(?:c|ctrl)[-+]([a-z])$/i.exec(text.trim());
  if (!match) return undefined;
  const letter = match[1]!.toLowerCase();
  if (RESERVED.has(letter)) return undefined;
  return { key: String.fromCharCode(letter.charCodeAt(0) - 96), label: `Ctrl-${letter}` };
}

export function loadDeskConfig(dir: string): { config: DeskConfig; warnings: string[] } {
  let raw: string;
  try {
    raw = readFileSync(join(dir, CONFIG_FILE), 'utf8');
  } catch {
    return { config: {}, warnings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: {}, warnings: [`${CONFIG_FILE}을 JSON으로 읽지 못해 기본 설정을 씁니다`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { config: {}, warnings: [`${CONFIG_FILE}은 객체여야 해서 기본 설정을 씁니다`] };
  const values = parsed as Record<string, unknown>;
  const config: DeskConfig = {};
  const warnings: string[] = [];
  if (values.prefix !== undefined) {
    const prefix = typeof values.prefix === 'string' ? parsePrefix(values.prefix) : undefined;
    if (prefix) config.prefix = prefix;
    else warnings.push(`prefix는 "C-a" 꼴이어야 합니다(Ctrl-c·h·i·j·m은 쓸 수 없음). Ctrl-b를 씁니다`);
  }
  for (const key of ['notify', 'mouse', 'animate'] as const) {
    if (values[key] === undefined) continue;
    if (typeof values[key] === 'boolean') config[key] = values[key];
    else warnings.push(`${key}는 true나 false여야 합니다. 기본값(켬)을 씁니다`);
  }
  if (values.sprites !== undefined) {
    if (SPRITE_SETTINGS.includes(values.sprites as SpriteSetting)) config.sprites = values.sprites as SpriteSetting;
    else warnings.push(`sprites는 "random", "named", "off" 중 하나여야 합니다. random을 씁니다`);
  }
  if (values.graphics !== undefined) {
    if (GRAPHICS.includes(values.graphics as GraphicsSetting)) config.graphics = values.graphics as GraphicsSetting;
    else warnings.push(`graphics는 "auto", "kitty", "blocks" 중 하나여야 합니다. auto를 씁니다`);
  }
  if (values.color !== undefined) {
    if (COLORS.includes(values.color as ColorSetting)) config.color = values.color as ColorSetting;
    else warnings.push(`color는 "auto", "truecolor", "256" 중 하나여야 합니다. auto를 씁니다`);
  }
  if (values.theme !== undefined) {
    if (THEMES.includes(values.theme as ThemeName)) config.theme = values.theme as ThemeName;
    else warnings.push(`theme은 ${THEMES.map((name) => `"${name}"`).join(', ')} 중 하나여야 합니다. dark를 씁니다`);
  }
  return { config, warnings };
}

/**
 * 설정 화면(#890)에서 바꾼 값을 desk.json에 쓴다. 받은 값만 바꾸고 파일에 있던 다른 값(모르는 키 포함)은 그대로 둔다.
 * 파일이 없거나 JSON 객체가 아니면 받은 값으로 새로 쓴다. 쓰다 끊겨도 앞 파일이 깨지지 않게 옆 파일에 쓰고 바꿔 단다. 실패하면 던진다
 */
export function saveDeskConfig(dir: string, patch: DeskConfig): void {
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, CONFIG_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // 없거나 깨진 파일은 새로 쓴다
  }
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch) as Array<[keyof DeskConfig, DeskConfig[keyof DeskConfig]]>) {
    if (value === undefined) continue;
    // 앞글쇠는 사람이 읽고 고치는 꼴(Ctrl-a)로 남긴다. 읽을 때 parsePrefix가 받는다
    next[key] = key === 'prefix' ? (value as DeskPrefix).label : value;
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, CONFIG_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, file);
}

/** 밖 터미널이 24비트 색을 그리는가. 설정이 앞서고, auto면 COLORTERM을 본다(truecolor·24bit가 아니면 256색으로 낮춘다) */
export function colorDepth(env: NodeJS.ProcessEnv, setting: ColorSetting = 'auto'): 'truecolor' | '256' {
  if (setting !== 'auto') return setting;
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  return colorterm === 'truecolor' || colorterm === '24bit' ? 'truecolor' : '256';
}

export function loadDeskLayout(dir: string): DeskLayout | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, LAYOUT_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const values = parsed as Record<string, unknown>;
  const layout: PaneLayout = values.layout === 2 || values.layout === 4 ? values.layout : 1;
  const saved = Array.isArray(values.slots) ? values.slots : [];
  const slots = Array.from({ length: SLOT_COUNT }, (_, slot) => {
    const id = saved[slot];
    return typeof id === 'string' && id && slot < layout ? id : undefined;
  });
  const focus = typeof values.focus === 'number' && Number.isInteger(values.focus) && values.focus >= 0 && values.focus < layout ? values.focus : 0;
  return { layout, slots, focus, zoom: values.zoom === true, sidebarHidden: values.sidebarHidden === true };
}

/** 배치를 쓴다. 쓰다 끊겨도 앞 파일이 깨지지 않게 옆 파일에 쓰고 바꿔 단다. 실패하면 던진다 */
export function saveDeskLayout(dir: string, layout: DeskLayout): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, LAYOUT_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...layout, slots: layout.slots.map((id) => id ?? null) }, null, 2)}\n`);
  renameSync(temp, file);
}
