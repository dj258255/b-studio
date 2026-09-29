import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRevocations, revokeSession, revokeUser } from './auth-state';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-auth-'));
  roots.push(root);
  return path.join(root, 'auth');
}

describe('로그인 무효화 기록', () => {
  it('파일이 없으면 비어 있고, 로그아웃한 세션과 무효화한 사용자를 남기며 만료된 세션은 지운다', async () => {
    const dir = await stateDir();
    expect(readRevocations(dir)).toEqual({ sessions: {}, users: {} });

    await revokeSession({ sid: 'a'.repeat(32), expiresAt: 2_000 }, 1_000, dir);
    await revokeUser('bob', 1_500, dir);
    expect(readRevocations(dir)).toEqual({ sessions: { ['a'.repeat(32)]: 2_000 }, users: { bob: 1_500 } });
    expect((await stat(path.join(dir, 'revocations.json'))).mode & 0o777).toBe(0o600);

    await revokeSession({ sid: 'b'.repeat(32), expiresAt: 9_000 }, 3_000, dir);
    expect(readRevocations(dir)).toEqual({ sessions: { ['b'.repeat(32)]: 9_000 }, users: { bob: 1_500 } });
  });

  it('동시에 무효화해도 하나도 잃지 않는다', async () => {
    const dir = await stateDir();
    await Promise.all(Array.from({ length: 20 }, (_, i) => revokeSession({ sid: i.toString(16).padStart(32, '0'), expiresAt: 10_000 }, 0, dir)));
    expect(Object.keys(readRevocations(dir).sessions)).toHaveLength(20);
  });

  // 세션 무효화와 사용자 무효화는 같은 파일의 다른 필드다. 한 번에 들어와도 나중 쓰기가 앞의 갱신을 덮어쓰면 안 된다
  it('세션 무효화와 사용자 무효화가 동시에 들어와도 둘 다 남는다', async () => {
    const dir = await stateDir();
    const sid = 'c'.repeat(32);
    await Promise.all([revokeSession({ sid, expiresAt: 10_000 }, 0, dir), revokeUser('dave', 0, dir)]);
    expect(readRevocations(dir)).toEqual({ sessions: { [sid]: 10_000 }, users: { dave: 0 } });
  });

  it('다른 프로세스가 파일을 바꾸면 다시 읽고, 형식이 틀리면 던진다', async () => {
    const dir = await stateDir();
    await revokeUser('alice', 1, dir);
    expect(readRevocations(dir).users).toEqual({ alice: 1 });

    await writeFile(path.join(dir, 'revocations.json'), JSON.stringify({ version: 1, sessions: {}, users: { alice: 1, carol: 22 } }));
    expect(readRevocations(dir).users).toEqual({ alice: 1, carol: 22 });

    await writeFile(path.join(dir, 'revocations.json'), '{"sessions": 3}');
    expect(() => readRevocations(dir)).toThrow('revocations.json');
  });
});
