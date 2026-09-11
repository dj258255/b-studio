import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { NO_REVOCATIONS, sessionUser, type AuthConfig, type Revocations, type SessionClaims } from './auth';

/**
 * 로그인 무효화 기록. 서명 쿠키는 서버에 세션을 두지 않으므로, 로그아웃한 세션 ID와 운영자가 무효화한 사용자만 파일에 남긴다.
 * proxy.ts가 요청마다 읽으므로 가벼운 모듈만 불러오고, 라우트와 메모리를 나눠 쓴다고 가정하지 않는다
 */
const FILE = 'revocations.json';

interface Cache {
  file: string;
  mtimeMs: number;
  size: number;
  value: Revocations;
}

const globalState = globalThis as typeof globalThis & { __bStudioRevocations?: Cache; __bStudioRevocationWrites?: Promise<unknown> };

export function authStateDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.B_STUDIO_AUTH_STATE_DIR ?? path.join(homedir(), '.cache/b-studio/auth'));
}

/** 파일이 바뀌었을 때만 다시 읽는다. 파일이 없으면 무효화한 것이 없다. 읽을 수 없으면 던져 인증을 건너뛰지 않게 한다 */
export function readRevocations(dir = authStateDir()): Revocations {
  const file = path.join(/*turbopackIgnore: true*/ dir, FILE);
  let stat;
  try {
    stat = statSync(/*turbopackIgnore: true*/ file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NO_REVOCATIONS;
    throw new Error(`${file}을(를) 읽지 못했습니다: ${(error as Error).message}`);
  }
  const cached = globalState.__bStudioRevocations;
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const value = parseRevocations(readFileSync(/*turbopackIgnore: true*/ file, 'utf8'), file);
  globalState.__bStudioRevocations = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

function parseRevocations(text: string, file: string): Revocations {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file}을(를) 읽지 못했습니다: JSON이 아닙니다`);
  }
  const isRecord = (value: unknown): value is Record<string, number> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'number');
  const { sessions, users } = (data ?? {}) as { sessions?: unknown; users?: unknown };
  if (!isRecord(sessions) || !isRecord(users)) throw new Error(`${file}을(를) 읽지 못했습니다: sessions와 users가 숫자 값을 가진 객체여야 합니다`);
  return { sessions, users };
}

/** 지금 시각과 무효화 기록으로 확인한 쿠키의 사용자. 화면(서버 컴포넌트)이 렌더링 중에 시각을 직접 읽지 않게 여기서 읽는다 */
export function activeSessionUser(cookie: string | undefined, config: AuthConfig): string | undefined {
  return sessionUser(cookie, config, Date.now(), readRevocations());
}

/** 로그아웃한 세션을 쿠키 만료 시각까지 거부한다 */
export function revokeSession(claims: Pick<SessionClaims, 'sid' | 'expiresAt'>, now = Date.now(), dir = authStateDir()): Promise<Revocations> {
  return update(dir, now, (draft) => {
    draft.sessions[claims.sid] = claims.expiresAt;
  });
}

/** 이 시각까지 발급한 사용자의 쿠키를 모두 거부한다. 다시 로그인하면 새 쿠키는 받는다 */
export function revokeUser(user: string, now = Date.now(), dir = authStateDir()): Promise<Revocations> {
  return update(dir, now, (draft) => {
    draft.users[user] = now;
  });
}

/** 같은 프로세스의 쓰기는 차례로 하고, 다른 프로세스가 반쯤 쓴 파일을 읽지 않게 임시 파일을 옮겨 바꾼다 */
function update(dir: string, now: number, change: (draft: { sessions: Record<string, number>; users: Record<string, number> }) => void): Promise<Revocations> {
  const run = async (): Promise<Revocations> => {
    const current = readRevocations(dir);
    // 만료된 쿠키는 어차피 거부되므로 기록에서 뺀다
    const draft = { sessions: Object.fromEntries(Object.entries(current.sessions).filter(([, expiresAt]) => expiresAt > now)), users: { ...current.users } };
    change(draft);
    await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
    const file = path.join(/*turbopackIgnore: true*/ dir, FILE);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(/*turbopackIgnore: true*/ temp, JSON.stringify({ version: 1, ...draft }, null, 2), { mode: 0o600 });
    await rename(/*turbopackIgnore: true*/ temp, file);
    return draft;
  };
  const result = (globalState.__bStudioRevocationWrites ?? Promise.resolve()).then(run, run);
  globalState.__bStudioRevocationWrites = result.catch(() => undefined);
  return result;
}
