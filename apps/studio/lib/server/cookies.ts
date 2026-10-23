/**
 * 쿠키 읽기·쓰기. 라우트가 표준 Request·Response만으로 쿠키를 다루게 한다
 */

/** Cookie 헤더에서 이름 하나의 값을 꺼낸다 */
export function cookieValue(headers: Headers, name: string): string | undefined {
  const header = headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  secure?: boolean;
  path?: string;
  /** 초. 0이면 지운다 */
  maxAge?: number;
}

/** Set-Cookie 한 줄. 값은 서명한 토큰처럼 쿠키에 그대로 넣어도 되는 글자만 받는다 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) throw new Error(`쿠키 ${name}의 값에 쓸 수 없는 글자가 있습니다`);
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.round(options.maxAge))}`);
    if (options.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
  return parts.join('; ');
}

/** 쿠키를 지우는 Set-Cookie 한 줄 */
export function clearCookie(name: string, path = '/'): string {
  return serializeCookie(name, '', { path, maxAge: 0 });
}
