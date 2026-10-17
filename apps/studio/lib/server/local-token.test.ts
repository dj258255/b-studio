import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasLocalToken, LOCAL_TOKEN_API_PATH, LOCAL_TOKEN_COOKIE, LOCAL_TOKEN_PAGE_PATH, localToken, localTokenPath } from './local-token';

const cache = globalThis as typeof globalThis & { __bStudioLocalToken?: string };
const tokenFile = (dir: string) => path.join(dir, '.cache', 'b-studio', 'launch', 'local-token');

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'local-token-'));
  env = { B_STUDIO_LOCAL_TOKEN_FILE: tokenFile(dir) };
  delete cache.__bStudioLocalToken;
});

afterEach(async () => {
  delete cache.__bStudioLocalToken;
  await rm(dir, { recursive: true, force: true });
});

describe('로컬 토큰(ADR-173 덧붙임)', () => {
  it('쿠키 이름과 교환 경로를 정한다', () => {
    expect(LOCAL_TOKEN_COOKIE).toBe('b_studio_local');
    expect(LOCAL_TOKEN_PAGE_PATH).toBe('/local-auth');
    expect(LOCAL_TOKEN_API_PATH).toBe('/api/local-auth');
  });

  it('처음 부를 때 만들어 이 사용자만 읽을 수 있는 파일(0600)에 쓰고, 다시 불러도 같은 값을 준다', async () => {
    const token = localToken(env);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(localToken(env)).toBe(token);

    const file = tokenFile(dir);
    expect((await readFile(file, 'utf8')).trim()).toBe(token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('서버를 다시 띄우면 새 값이고 파일도 덮어쓴다', async () => {
    const first = localToken(env);
    // 프로세스가 다시 뜬 것과 같게 만든다
    delete cache.__bStudioLocalToken;
    const second = localToken(env);
    expect(second).not.toBe(first);
    expect((await readFile(tokenFile(dir), 'utf8')).trim()).toBe(second);
  });

  it('쿠키 값이 이 서버의 토큰과 같은 때만 참이다', () => {
    const token = localToken(env);
    expect(hasLocalToken(token, env)).toBe(true);
    expect(hasLocalToken('a'.repeat(64), env)).toBe(false);
    expect(hasLocalToken(token.slice(0, 63), env)).toBe(false);
    expect(hasLocalToken('', env)).toBe(false);
    expect(hasLocalToken(undefined, env)).toBe(false);
  });

  it('파일 자리는 B_STUDIO_LOCAL_TOKEN_FILE로 바꿀 수 있고, 없으면 홈의 캐시 폴더를 쓴다', () => {
    expect(localTokenPath({ HOME: '/home/kim' })).toBe('/home/kim/.cache/b-studio/launch/local-token');
    expect(localTokenPath({ HOME: '/home/kim', B_STUDIO_LOCAL_TOKEN_FILE: '/tmp/x' })).toBe('/tmp/x');
  });

  it('파일 자리에 링크가 있으면 그 너머를 건드리지 않고 링크 자체를 바꾼다', async () => {
    const file = tokenFile(dir);
    await mkdir(path.dirname(file), { recursive: true });
    const target = path.join(dir, '건드리면-안-되는-파일');
    await writeFile(target, '그대로 남아야 한다\n');
    await symlink(target, file);

    const token = localToken(env);
    expect((await readFile(target, 'utf8')).trim()).toBe('그대로 남아야 한다');
    expect((await lstat(file)).isSymbolicLink()).toBe(false);
    expect((await readFile(file, 'utf8')).trim()).toBe(token);
  });
});
