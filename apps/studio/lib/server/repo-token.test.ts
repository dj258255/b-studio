import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedRepositoryToken, ghCliToken, clearRepositoryTokenCache, localFolderAllowed } from './repo-token';

describe('localFolderAllowed', () => {
  const savedAuth = process.env.B_STUDIO_AUTH;
  afterEach(() => {
    if (savedAuth === undefined) delete process.env.B_STUDIO_AUTH;
    else process.env.B_STUDIO_AUTH = savedAuth;
  });

  it('B_STUDIO_AUTH가 none이거나 없으면 허용하고, 그 밖이면 막는다', () => {
    delete process.env.B_STUDIO_AUTH;
    expect(localFolderAllowed()).toBe(true);
    process.env.B_STUDIO_AUTH = 'none';
    expect(localFolderAllowed()).toBe(true);
    process.env.B_STUDIO_AUTH = 'token';
    expect(localFolderAllowed()).toBe(false);
  });
});

describe('cachedRepositoryToken(ADR-107: 저장소 올리기 미리보기 → 실제 생성이 gh CLI를 거듭 부르지 않는다)', () => {
  beforeEach(() => clearRepositoryTokenCache());

  it('TTL 안에서는 다시 묻지 않고 캐시된 값을 돌려준다', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    let now = 1_000;
    const token1 = await cachedRepositoryToken('github', { env: {}, allowGhCli: true, ghToken, now: () => now });
    now += 1_000; // TTL(5s) 안
    const token2 = await cachedRepositoryToken('github', { env: {}, allowGhCli: true, ghToken, now: () => now });

    expect(token1).toBe('from-cli');
    expect(token2).toBe('from-cli');
    expect(ghToken).toHaveBeenCalledOnce();
  });

  it('TTL이 지나면 다시 묻는다', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    let now = 1_000;
    await cachedRepositoryToken('github', { env: {}, allowGhCli: true, ghToken, now: () => now });
    now += 6_000; // TTL(5s)을 넘겼다
    await cachedRepositoryToken('github', { env: {}, allowGhCli: true, ghToken, now: () => now });

    expect(ghToken).toHaveBeenCalledTimes(2);
  });

  it('환경 변수가 있으면 gh CLI를 부르지 않고 그 값을 쓴다', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    const token = await cachedRepositoryToken('github', { env: { B_STUDIO_GITHUB_TOKEN: 'from-env' }, allowGhCli: true, ghToken });

    expect(token).toBe('from-env');
    expect(ghToken).not.toHaveBeenCalled();
  });

  it('gitea는 gh CLI 대체가 없다(GitHub 로그인 토큰이 gitea에서는 뜻이 없다)', async () => {
    const ghToken = vi.fn(async () => 'from-cli');
    const token = await cachedRepositoryToken('gitea', { env: {}, allowGhCli: true, ghToken });

    expect(token).toBeUndefined();
    expect(ghToken).not.toHaveBeenCalled();
  });
});

describe('ghCliToken — 테스트 중 실제 gh 차단', () => {
  it('실행기를 주입하지 않으면 테스트 실행 중에는 실제 gh를 부르지 않는다', async () => {
    expect(process.env.VITEST).toBeTruthy();
    await expect(ghCliToken()).resolves.toBeUndefined();
  });
});
