import { afterEach, describe, expect, it } from 'vitest';
import { currentDevStatus, isDevMode, resetDevStatusBootCache, type DevStatusDeps } from './dev-status';

afterEach(() => {
  resetDevStatusBootCache();
});

function deps(overrides: Partial<DevStatusDeps> = {}): DevStatusDeps {
  return { gitHead: async () => 'abc1234', lockfileHash: async () => 'lock-a', isDevMode: () => true, ...overrides };
}

describe('isDevMode', () => {
  it('NODE_ENV가 production이 아니면 개발 모드다(설정하지 않은 테스트·next dev 모두 development로 본다)', () => {
    expect(isDevMode({})).toBe(true);
    expect(isDevMode({ NODE_ENV: 'development' })).toBe(true);
    expect(isDevMode({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('currentDevStatus', () => {
  it('운영 빌드(isDevMode=false)면 git을 부르지 않고 undefined를 돌려준다', async () => {
    let called = false;
    const status = await currentDevStatus(
      deps({
        isDevMode: () => false,
        gitHead: async () => {
          called = true;
          return 'abc1234';
        },
      }),
    );
    expect(status).toBeUndefined();
    expect(called).toBe(false);
  });

  it('git 저장소가 아니면(gitHead가 undefined) undefined를 돌려준다', async () => {
    const status = await currentDevStatus(deps({ gitHead: async () => undefined }));
    expect(status).toBeUndefined();
  });

  it('부팅 뒤 커밋이 그대로면 codeChanged는 false다', async () => {
    const status = await currentDevStatus(deps());
    expect(status).toEqual({ bootHead: 'abc1234', headNow: 'abc1234', codeChanged: false, lockfileChanged: false });
  });

  it('부팅 시점의 커밋을 한 번만 읽고(캐시), 그 뒤 git pull로 커밋이 바뀌면 codeChanged가 true다', async () => {
    let head = 'abc1234';
    const d = deps({ gitHead: async () => head });

    const first = await currentDevStatus(d);
    expect(first).toEqual({ bootHead: 'abc1234', headNow: 'abc1234', codeChanged: false, lockfileChanged: false });

    head = 'def5678';
    const second = await currentDevStatus(d);
    // 부팅 시점(bootHead)은 캐시된 첫 값 그대로, 지금 커밋만 바뀐다
    expect(second).toEqual({ bootHead: 'abc1234', headNow: 'def5678', codeChanged: true, lockfileChanged: false });
  });

  it('부팅 뒤 pnpm-lock.yaml 해시가 바뀌면 lockfileChanged가 true다', async () => {
    let lock = 'lock-a';
    const d = deps({ lockfileHash: async () => lock });

    await currentDevStatus(d);
    lock = 'lock-b';
    const status = await currentDevStatus(d);
    expect(status?.lockfileChanged).toBe(true);
    expect(status?.codeChanged).toBe(false);
  });

  it('지금 커밋을 읽지 못하면(일시적 git 오류) 바뀌지 않은 것으로 본다', async () => {
    let fail = false;
    const d = deps({ gitHead: async () => (fail ? undefined : 'abc1234') });

    await currentDevStatus(d);
    fail = true;
    const status = await currentDevStatus(d);
    expect(status).toEqual({ bootHead: 'abc1234', headNow: 'abc1234', codeChanged: false, lockfileChanged: false });
  });
});
