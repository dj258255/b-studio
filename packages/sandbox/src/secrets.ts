import { readFile } from 'node:fs/promises';
import type { LoadedProject } from '@b-studio/spec';
import { native, type NativeRedactor } from './native';

/** 이보다 짧은 값은 로그의 평범한 단어와 겹쳐, 가림이 확실하지 않거나 출력을 망가뜨린다 */
export const MIN_SECRET_LENGTH = 8;
/** 스튜디오 서버 환경 변수 `B_STUDIO_SECRET_<이름>`으로 값을 넣는다 */
export const SECRET_ENV_PREFIX = 'B_STUDIO_SECRET_';

export class SecretError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(`${message}\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'SecretError';
    this.issues = issues;
  }
}

export interface ResolveSecretsOptions {
  env?: NodeJS.ProcessEnv;
  /** KEY=VALUE 형식 파일. 기본은 B_STUDIO_SECRETS_FILE */
  file?: string;
}

/**
 * studio.yaml에 선언한 시크릿의 값을 스튜디오 서버 쪽에서 찾는다.
 * 에이전트가 읽고 체크포인트로 커밋하는 프로젝트 폴더에서는 읽지 않는다.
 * 환경 변수가 시크릿 파일보다 우선하고, 오류 메시지에는 값을 넣지 않는다.
 */
export async function resolveSecrets(
  project: LoadedProject,
  { env = process.env, file = env.B_STUDIO_SECRETS_FILE }: ResolveSecretsOptions = {},
): Promise<Record<string, string>> {
  const declared = project.secrets ?? [];
  if (declared.length === 0) return {};

  let fromFile: Record<string, string> = {};
  if (file) {
    try {
      fromFile = parseDotenv(await readFile(file, 'utf8'));
    } catch (error) {
      throw new SecretError('시크릿 파일을 읽지 못했습니다', [`${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`]);
    }
  }

  const values: Record<string, string> = {};
  const issues: string[] = [];
  for (const [name] of declared) {
    const value = env[`${SECRET_ENV_PREFIX}${name}`] || fromFile[name];
    if (!value) {
      issues.push(`${name}: 값이 없습니다. ${SECRET_ENV_PREFIX}${name} 환경 변수나 B_STUDIO_SECRETS_FILE 파일에 넣으세요`);
    } else if (value.length < MIN_SECRET_LENGTH) {
      issues.push(`${name}: ${MIN_SECRET_LENGTH}자보다 짧은 값은 출력에서 확실히 가릴 수 없어 받지 않습니다`);
    } else {
      values[name] = value;
    }
  }
  if (issues.length > 0) throw new SecretError('시크릿을 준비하지 못했습니다', issues);
  return values;
}

/** `KEY=VALUE` 줄을 읽는다. 빈 줄과 `#` 주석은 건너뛰고, 값을 감싼 따옴표 한 쌍은 벗긴다(판정은 Rust: crates/bstudio-guard/src/secrets.rs) */
export function parseDotenv(text: string): Record<string, string> {
  return Object.fromEntries(native.parseDotenv(text));
}

/**
 * 샌드박스에서 나오는 텍스트(로그, 명령 출력, HTTP 응답, 파일 내용)에서 시크릿 값을 찾고 가린다.
 * 원래 값, URL 인코딩한 값, base64로 인코딩한 값을 긴 값부터 가린다(판정은 Rust)
 */
export class Redactor {
  readonly #native: NativeRedactor;

  constructor(secrets: Record<string, string>) {
    // 같은 길이의 값끼리는 넘긴 순서를 지킨다. JS 객체의 순서(Object.entries)를 그대로 넘긴다
    const entries = Object.entries(secrets);
    this.#native = new native.NativeRedactor(
      entries.map(([name]) => name),
      entries.map(([, value]) => value),
    );
  }

  redact(text: string): string {
    return this.#native.redact(text);
  }

  /** 텍스트에 값이 들어 있는 시크릿 이름 */
  find(text: string): string[] {
    return this.#native.find(text);
  }
}
