import { readFile } from 'node:fs/promises';
import type { LoadedProject } from '@b-studio/spec';

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

/** `KEY=VALUE` 줄을 읽는다. 빈 줄과 `#` 주석은 건너뛰고, 값을 감싼 따옴표 한 쌍은 벗긴다 */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!;
    values[match[1]!] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return values;
}

/** 샌드박스에서 나오는 텍스트(로그, 명령 출력, HTTP 응답, 파일 내용)에서 시크릿 값을 찾고 가린다 */
export class Redactor {
  readonly #patterns: Array<{ name: string; forms: string[] }>;

  constructor(secrets: Record<string, string>) {
    this.#patterns = Object.entries(secrets)
      // URL 쿼리나 폼 본문에 들어간 값, base64로 인코딩한 출력(`| base64`, Basic 인증 헤더)도 가린다
      .map(([name, value]) => ({ name, forms: [...new Set([value, encodeURIComponent(value), ...base64Cores(value)])] }))
      // 한 값이 다른 값을 포함하면 긴 값부터 가려야 가린 자리에 맞는 이름이 남는다
      .sort((a, b) => b.forms[0]!.length - a.forms[0]!.length);
  }

  redact(text: string): string {
    let result = text;
    for (const { name, forms } of this.#patterns) {
      for (const form of forms) result = result.replaceAll(form, `[${name} 가림]`);
    }
    return result;
  }

  /** 텍스트에 값이 들어 있는 시크릿 이름 */
  find(text: string): string[] {
    return this.#patterns.filter(({ forms }) => forms.some((form) => text.includes(form))).map(({ name }) => name).sort();
  }
}

/**
 * base64는 3바이트씩 묶어 인코딩하므로 같은 값도 앞에 몇 바이트가 붙느냐(0~2)에 따라 다른 문자열이 된다.
 * 각 경우에 앞뒤 바이트와 섞이지 않고 값만으로 정해지는 구간을 돌려준다. 경계의 1~2글자는 남지만 값을 복원할 수 없다
 */
function base64Cores(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    // 앞 바이트의 비트가 섞인 글자를 건너뛰고, 뒤에 올 바이트와 섞일 마지막 글자와 패딩은 뺀다
    const start = [0, 2, 3][offset]!;
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    return encoded.slice(start, end);
  });
}
