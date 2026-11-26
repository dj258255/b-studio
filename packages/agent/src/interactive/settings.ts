import { readFileSync } from 'node:fs';

/** 설정 파일의 훅 하나. 명령형만 부른다 */
export interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
  async?: boolean;
}
export interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}
export interface InteractiveSettings {
  hooks?: Record<string, HookEntry[]>;
  env?: Record<string, string>;
}

export interface ParsedArgs {
  settingsFile?: string;
  model?: string;
  /** `--mcp-config`의 값(설정 파일 경로). 없으면 칸이 없다 */
  mcpConfigs?: string[];
  /** 마지막 위치 인자: 첫 요청 */
  firstRequest?: string;
}

/**
 * 값을 받는 옵션(그 다음 낱말은 위치 인자가 아니다). `--mcp-config`는 값을 여러 개 받는 옵션이라
 * 서버가 `--settings`를 뒤에 두어(host-terminal.ts의 hostCliWrapper) 첫 낱말(요청 글)이 설정 파일로 먹히지 않게 한다.
 * 여기서는 `--mcp-config`의 값을 여러 개 받아 mcpConfigs에 모은다(읽는 일은 mcp.ts가 한다)
 */
const SINGLE_VALUE_OPTIONS = new Set(['--settings', '--model', '--resume']);
const MULTI_VALUE_OPTIONS = new Set(['--mcp-config']);

export function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (MULTI_VALUE_OPTIONS.has(name)) {
      // `--mcp-config=값`은 값 하나, 아니면 다음 옵션(`-`로 시작)이 나올 때까지 모두 값이다
      const values = eq > 0 ? [arg.slice(eq + 1)] : [];
      if (eq < 0) while (index + 1 < args.length && !args[index + 1]!.startsWith('-')) values.push(args[++index]!);
      if (values.length > 0) parsed.mcpConfigs = [...(parsed.mcpConfigs ?? []), ...values];
      continue;
    }
    if (SINGLE_VALUE_OPTIONS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++index];
      if (name === '--model') parsed.model = value;
      else if (name === '--settings') parsed.settingsFile = value;
      continue;
    }
    if (!arg.startsWith('-')) positional.push(arg);
  }
  parsed.firstRequest = positional.at(-1);
  return parsed;
}

export function loadSettings(file: string | undefined): InteractiveSettings {
  if (!file) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return typeof parsed === 'object' && parsed !== null ? (parsed as InteractiveSettings) : {};
}
