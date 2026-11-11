import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signSession } from '@/lib/server/auth';
import { buildFront, exchange, repoRoot, startFront, startNodeDirect, type RunningFront, type RunningNode } from './front-test-helper';

/**
 * HTTP 차등 시험(ADR-195 4d): 앞단이 직접 답하는 `GET /api/ai-accounts`를 진짜 Node 서버를 직접 띄운 것과 앞단 너머로 띄운 것에
 * 같은 날것의 요청으로 보내 상태·본문·머리(연결 틀 머리 제외)가 같은지 본다. 직접 답했는지(Node에 닿지 않았는지)는 Rust 시험(tests/routes_front.rs)이 본다.
 * 임시 폴더·임시 포트만 쓴다. 두 서버는 같은 HOME(계정 목록 파일)을 읽는다
 */
interface Pair {
  direct: RunningNode;
  front: RunningFront;
  dir: string;
}

async function startPair(extraEnv: Record<string, string>): Promise<Pair> {
  const binary = await buildFront();
  const dir = await mkdtemp(path.join('/tmp', 'bsr-'));
  const env = {
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    HOME: dir,
    B_STUDIO_MODE: 'claude-code',
    B_STUDIO_SESSIONS_DIR: path.join(dir, 'sessions'),
    B_STUDIO_LOCAL_TOKEN_FILE: path.join(dir, 'local-token'),
    B_STUDIO_AUTH_STATE_DIR: path.join(dir, 'auth'),
    ...extraEnv,
  };
  const direct = await startNodeDirect(env);
  const front = await startFront(binary, ['--port', '0', '--hostname', '127.0.0.1', '--run-dir', path.join(dir, 'run'), '--', path.join(repoRoot, 'node_modules/.bin/tsx'), '--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/server/main.ts'], env, 120_000);
  return { direct, front, dir };
}

async function stopPair(pair: Pair | undefined): Promise<void> {
  await pair?.front.stop();
  await pair?.direct.stop();
  if (pair) await rm(pair.dir, { recursive: true, force: true });
}

type Headers = [string, string][];
let compared = 0;
afterAll(() => console.log(`HTTP 차등 비교 ${compared}건`));
const localhost: [string, string] = ['Host', 'localhost:3000'];

async function same(pair: Pair, line: string, headers: Headers, status: number, name = line): Promise<void> {
  compared += 1;
  const isHead = line.startsWith('HEAD ');
  const expected = await exchange(pair.direct.origin, line, headers, isHead);
  const actual = await exchange(pair.front.origin, line, headers, isHead);
  expect(expected.status, `${name}: Node 직접 상태 ${expected.body}`).toBe(status);
  expect(actual, name).toEqual(expected);
}

const writeAccounts = async (pair: Pair, content: string | undefined) => {
  const file = path.join(pair.dir, '.config', 'b-studio', 'accounts.json');
  await mkdir(path.dirname(file), { recursive: true });
  await rm(file, { recursive: true, force: true });
  if (content !== undefined) await writeFile(file, content);
};

describe('인증 없음(개인 PC 모드)', () => {
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_BACKENDS: 'codex, gemini ,,' });
  }, 400_000);
  afterAll(() => stopPair(pair));

  const list = (target = '/api/ai-accounts', headers: Headers = [localhost], status = 200) => same(pair!, `GET ${target} HTTP/1.1`, headers, status, `GET ${target} ${JSON.stringify(headers)}`);

  it('파일이 없으면 허용한 CLI의 기본 계정', async () => {
    await writeAccounts(pair!, undefined);
    await list();
    await list('/api/ai-accounts?x=1&y=%7B');
  });

  it('저장한 계정은 기본 계정 뒤에, 키 순서와 이스케이프까지 같다', async () => {
    await writeAccounts(
      pair!,
      JSON.stringify({
        accounts: [
          { id: 'acct-1', name: '업무 "A"\u0001 ', backend: 'codex', configDir: '/h/.c', sprite: 'a/b.PNG', extra: 1 },
          { id: 'claude-code', name: '내 것', backend: 'claude-code' },
          { id: 'codex', name: ' 이름 ', backend: 'codex', sprite: 'pokemon/25.gif' },
          { id: 'acct-2', name: 'x', backend: 'gemini', configDir: '/h/.g' },
          { id: 'acct-3', name: 'y', backend: 'opencode' },
        ],
      }),
    );
    await list();
    // 같은 키가 둘이면 뒤의 값
    await writeAccounts(pair!, '{"accounts":[{"id":"a","id":"acct-9","name":"x","backend":"codex"}]}');
    await list();
  });

  it('파일이 틀리면 Node가 500을 준다(앞단은 넘긴다)', async () => {
    for (const bad of ['{', '[]', '{"accounts":{}}', '{"accounts":[1]}', '{"accounts":[{"id":"A","name":"x","backend":"codex"}]}', '{"accounts":[{"id":"a","name":" ","backend":"codex"}]}', '{"accounts":[{"id":"a","name":"x","backend":"api"}]}', '{"accounts":[{"id":"a","name":"x","backend":"codex","configDir":"rel"}]}', '{"accounts":[{"id":"a","name":"x","backend":"codex","sprite":"a.jpg"}]}', '{"accounts":[{"id":"a","name":"x","backend":"codex","sprite":null}]}']) {
      await writeAccounts(pair!, bad);
      await list('/api/ai-accounts', [localhost], 500);
    }
    // 파일 자리가 폴더
    await writeAccounts(pair!, undefined);
    await mkdir(path.join(pair!.dir, '.config', 'b-studio', 'accounts.json'), { recursive: true });
    await list('/api/ai-accounts', [localhost], 500);
  });

  it('그림 경로 규칙의 경계(길이·깊이·점·확장자)', async () => {
    for (const sprite of ['a.png', 'A.GIF', 'a/b/c/d.png', 'a/b/c/d/e.png', `${'x'.repeat(124)}.png`, `${'x'.repeat(125)}.png`, `${'d'.repeat(64)}/a.png`, `${'d'.repeat(65)}/a.png`, '.png', '.a.png', 'a/.b/c.png', 'ab..png', 'a//b.png', '/a.png', 'a\\b.png', 'a.png ', 'é.png', '😀.png', 'a.jpg']) {
      await writeAccounts(pair!, JSON.stringify({ accounts: [{ id: 'acct-1', name: 'x', backend: 'codex', sprite }] }));
      compared += 1;
      const expected = await exchange(pair!.direct.origin, 'GET /api/ai-accounts HTTP/1.1', [localhost]);
      const actual = await exchange(pair!.front.origin, 'GET /api/ai-accounts HTTP/1.1', [localhost]);
      expect(actual, JSON.stringify(sprite)).toEqual(expected);
    }
  });

  it('경로·메서드·헤더가 맞지 않으면 Node가 답한다', async () => {
    await writeAccounts(pair!, undefined);
    await list('/api/ai-accounts/', [localhost]);
    await list('/api/%61i-accounts', [localhost]);
    await list('/api/./ai-accounts', [localhost]);
    await list('/api//ai-accounts', [localhost]);
    await list('/api\\ai-accounts', [localhost]);
    await list('/api/AI-accounts', [localhost], 404);
    await list('/api/ai-accounts/nope', [localhost], 405);
    await same(pair!, 'HEAD /api/ai-accounts HTTP/1.1', [localhost], 200);
    await same(pair!, 'OPTIONS /api/ai-accounts HTTP/1.1', [localhost], 204);
    await same(pair!, 'DELETE /api/ai-accounts HTTP/1.1', [localhost, ['Origin', 'http://localhost:3000'], ['Content-Length', '0']], 405);
  });

  it('인증 거절과 판단할 수 없는 요청은 Node와 같다', async () => {
    await writeAccounts(pair!, undefined);
    await list('/api/ai-accounts', [['Host', 'evil.example']], 403);
    await list('/api/ai-accounts', [['Host', 'localhost'], ['Host', 'evil.example']], 200);
    await list('/api/ai-accounts', [['Host', 'evil.example'], ['Host', 'localhost']], 403);
    await list('/api/ai-accounts', [['Host', '']], 500);
    await list('/api/ai-accounts', [], 400);
    await list('//u:p@h/api/ai-accounts', [localhost], 500);
    await same(pair!, 'POST /api/ai-accounts HTTP/1.1', [localhost, ['Origin', 'http://evil.example'], ['Content-Length', '0']], 403);
  });
});

describe('B_STUDIO_BACKENDS가 틀린 설정', () => {
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_BACKENDS: 'bogus' });
  }, 400_000);
  afterAll(() => stopPair(pair));

  it('Node가 500을 준다(앞단은 넘긴다)', async () => {
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [localhost], 500);
  });
});

describe('데모 모드', () => {
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_MODE: 'demo' });
  }, 400_000);
  afterAll(() => stopPair(pair));

  it('빈 목록', async () => {
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [localhost], 200);
  });
});

describe('token 설정', () => {
  const secret = 'S'.repeat(32);
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: secret, B_STUDIO_AUTH_TOKENS: `alice:${'a'.repeat(24)}` });
  }, 400_000);
  afterAll(() => stopPair(pair));

  it('쿠키가 맞으면 403(개인 PC 모드가 아님), 없거나 틀리면 401', async () => {
    const cookie = `b_studio_session=${signSession('alice', secret, Date.now(), 1, '0'.repeat(32))}`;
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [localhost, ['Cookie', cookie]], 403);
    await same(pair!, 'GET /api/ai-accounts?a=1 HTTP/1.1', [localhost, ['Cookie', cookie]], 403);
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [localhost], 401);
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [localhost, ['Cookie', `b_studio_session=${signSession('mallory', secret, Date.now(), 1, '0'.repeat(32))}`]], 401);
    await same(pair!, 'HEAD /api/ai-accounts HTTP/1.1', [localhost, ['Cookie', cookie]], 403);
  });
});

describe('proxy 설정', () => {
  const secret = 'P'.repeat(32);
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: secret });
  }, 400_000);
  afterAll(() => stopPair(pair));

  it('프록시 헤더가 맞으면 403, 아니면 401', async () => {
    const host: [string, string] = ['Host', 'sso.example'];
    const ok: Headers = [host, ['X-B-Studio-Proxy-Secret', secret], ['X-Forwarded-User', 'alice']];
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', ok, 403);
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [host], 401);
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [host, ['X-B-Studio-Proxy-Secret', 'x'], ['X-Forwarded-User', 'alice']], 401);
    await same(pair!, 'GET /api/ai-accounts HTTP/1.1', [...ok, ['X-B-Studio-User', 'mallory']], 403);
  });
});
