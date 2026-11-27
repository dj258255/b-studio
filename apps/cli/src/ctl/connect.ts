/**
 * 스튜디오에 붙는다. 개인 PC는 desk와 같은 로컬 토큰 파일(findStudio)을 쓰고, 인증을 켠 서버(token 방식)는
 * 이름과 접근 토큰(`studio auth token`이 내준 것)으로 로그인해 세션 쿠키를 받아 쓴다. 판정은 모두 스튜디오가 한다
 */
import { findStudio, StudioClient, type StudioConnection } from '../desk/client';
import { EXIT } from './phase';

export class CtlError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

export interface ConnectOptions {
  port?: number;
  /** 인증을 켠 서버의 주소(http://host:port). 주면 로컬 토큰 대신 로그인한다 */
  url?: string;
  user?: string;
  token?: string;
}

/** 서버 주소를 정리한다. 경로·쿼리·계정 정보는 받지 않는다(그 주소 아래에 요청을 붙이므로 뜻이 달라진다) */
export function normalizeOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Set-Cookie 헤더에서 `이름=값`만 꺼낸다 */
export function cookiePair(setCookie: string | null): string | undefined {
  const first = setCookie?.split(';')[0]?.trim();
  return first && first.includes('=') ? first : undefined;
}

export async function connectStudio(env: Record<string, string | undefined>, options: ConnectOptions, fetchImpl: typeof fetch = fetch): Promise<StudioClient> {
  const url = options.url ?? env.B_STUDIO_URL;
  if (url) {
    const origin = normalizeOrigin(url);
    if (!origin) throw new CtlError(`--url(B_STUDIO_URL)은 http://주소:포트 꼴이어야 합니다 (지금 값: ${url})`, EXIT.usage);
    const user = options.user ?? env.B_STUDIO_USER;
    const token = options.token ?? env.B_STUDIO_TOKEN;
    if (!user || !token) throw new CtlError('인증을 켠 서버에는 이름과 접근 토큰이 필요합니다: B_STUDIO_USER·B_STUDIO_TOKEN 환경 변수(또는 --user·--token). 토큰은 `studio auth token <이름>`이 내줍니다', EXIT.usage);
    let response: Response;
    try {
      response = await fetchImpl(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: user, token }) });
    } catch (error) {
      throw new CtlError(`스튜디오(${origin})에 붙지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, EXIT.unreachable);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      const reason = typeof body.error === 'string' ? body.error : `${response.status}`;
      throw new CtlError(`로그인하지 못했습니다: ${reason}`, EXIT.unreachable);
    }
    const cookie = cookiePair(response.headers.get('set-cookie'));
    if (!cookie) throw new CtlError('로그인 응답에 세션 쿠키가 없습니다', EXIT.unreachable);
    const connection: StudioConnection = { origin, token: '', cookie };
    return new StudioClient(connection);
  }
  const found = await findStudio(env, { ...(options.port === undefined ? {} : { port: options.port }) });
  if ('error' in found) throw new CtlError(found.error, EXIT.unreachable);
  return new StudioClient(found);
}
