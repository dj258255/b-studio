import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 데스크톱 앱 설정(`~/.config/b-studio/desktop.json`).
 *
 * Dock·Finder에서 켠 앱에는 터미널 PATH(nvm·corepack)가 없다. 그래서 설치 시점에 확인한 경로를
 * `pnpm desktop:install`이 이 파일에 적어 두고, 앱은 그 경로로만 서버를 켠다.
 * 파일이 없으면 앱은 "pnpm desktop:install을 다시 실행하세요" 화면을 띄운다.
 */
export interface DesktopConfig {
  /** 저장소 루트. `pnpm studio launch`를 이 폴더에서 실행한다 */
  root: string;
  /** 설치 시점의 node 실행 파일(process.execPath). 자식 프로세스 PATH에 이 폴더를 넣는다 */
  node: string;
  /** 설치 시점의 pnpm 실행 파일(`command -v pnpm`) */
  pnpm: string;
  /** 서버 모드. 기본 local(이 PC에 로그인한 CLI로 실행) */
  mode: string;
  /** 서버 포트. 없으면 CLI가 고른다 */
  port?: number;
  /** 창 크기·위치 기억 */
  window?: WindowBounds;
}

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export const DEFAULT_MODE = 'local';

/**
 * 설정 파일 경로. 기본은 `~/.config/b-studio/desktop.json`이고,
 * `B_STUDIO_DESKTOP_CONFIG`로 바꿀 수 있다(테스트·개발용).
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.B_STUDIO_DESKTOP_CONFIG?.trim();
  return override ? path.resolve(override) : path.join(homedir(), '.config', 'b-studio', 'desktop.json');
}

/** 설정을 읽는다. 파일이 없으면 undefined(앱은 설치 안내 화면을 띄운다) */
export function readConfig(file: string = configPath()): DesktopConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseConfig(raw, file);
}

/** 설정 JSON을 읽고 검증한다. 형식이 틀리면 이유를 담아 던진다 */
export function parseConfig(raw: string, file = 'desktop.json'): DesktopConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file}을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}의 형식이 올바르지 않습니다`);
  const value = parsed as Record<string, unknown>;
  const text = (key: string): string => {
    const item = value[key];
    if (typeof item !== 'string' || item.trim() === '') throw new Error(`${file}의 ${key} 값이 비어 있습니다 — pnpm desktop:install을 다시 실행하세요`);
    return item;
  };
  const port = value.port;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error(`${file}의 port 값이 올바르지 않습니다: ${String(port)}`);
  }
  return {
    root: text('root'),
    node: text('node'),
    pnpm: text('pnpm'),
    mode: typeof value.mode === 'string' && value.mode.trim() !== '' ? value.mode.trim() : DEFAULT_MODE,
    ...(port === undefined ? {} : { port: port as number }),
    ...(isBounds(value.window) ? { window: value.window } : {}),
  };
}

/** 설정을 쓴다(폴더가 없으면 만든다). 사람이 읽을 수 있게 들여쓴다 */
export function writeConfig(config: DesktopConfig, file: string = configPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** 창 크기·위치만 갱신한다. 설정 파일이 없으면 아무것도 하지 않는다(설치 안내 화면이 떠 있는 상태) */
export function saveWindowBounds(bounds: WindowBounds, file: string = configPath()): void {
  const config = readConfig(file);
  if (!config) return;
  writeConfig({ ...config, window: bounds }, file);
}

function isBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bounds = value as Record<string, unknown>;
  return ['width', 'height'].every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]));
}
