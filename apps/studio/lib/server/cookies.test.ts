import { describe, expect, it } from 'vitest';
import { clearCookie, cookieValue, serializeCookie } from './cookies';

describe('쿠키 도우미', () => {
  it('Cookie 헤더에서 이름 하나의 값을 꺼낸다', () => {
    const headers = new Headers({ cookie: 'a=1; b_studio_session=v.sig ; c=3' });
    expect(cookieValue(headers, 'b_studio_session')).toBe('v.sig');
    expect(cookieValue(headers, 'none')).toBeUndefined();
    expect(cookieValue(new Headers(), 'a')).toBeUndefined();
  });

  it('Set-Cookie 한 줄을 만든다(Next cookies().set과 같은 속성)', () => {
    expect(serializeCookie('s', 'v.sig', { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 3600 })).toBe('s=v.sig; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax');
  });

  it('지우는 쿠키는 Max-Age=0과 지난 만료일', () => {
    expect(clearCookie('s')).toBe('s=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('쿠키 값에 쓸 수 없는 글자(;, 공백)는 거절한다', () => {
    expect(() => serializeCookie('s', 'a;b')).toThrow();
    expect(() => serializeCookie('s', 'a b')).toThrow();
  });
});
