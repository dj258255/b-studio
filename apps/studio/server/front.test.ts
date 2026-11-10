import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFront, repoRoot, startFront, type RunningFront } from './front-test-helper';

/**
 * 진짜 앞단(Rust)이 진짜 Node 서버(tsx main.ts)를 유닉스 소켓의 자식으로 띄우고 요청을 넘기는지 본다(ADR-195 4a).
 * 앞단 시험(crates/bstudio-server/tests)은 가짜 Node로 규칙을, 이 시험은 진짜 Node와의 이음을 본다. 임시 폴더·임시 포트만 쓴다
 */
let front: RunningFront | undefined;
let dir = '';
let runDir = '';

beforeAll(async () => {
  const binary = await buildFront();
  // 소켓 경로 상한이 있어 짧은 /tmp 아래에 둔다
  dir = await mkdtemp(path.join('/tmp', 'bs-'));
  runDir = path.join(dir, 'run');
  front = await startFront(
    binary,
    ['--port', '0', '--hostname', '127.0.0.1', '--run-dir', runDir, '--', path.join(repoRoot, 'node_modules/.bin/tsx'), '--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/server/main.ts'],
    {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      HOME: dir,
      B_STUDIO_MODE: 'demo',
      B_STUDIO_SESSIONS_DIR: path.join(dir, 'sessions'),
      B_STUDIO_LOCAL_TOKEN_FILE: path.join(dir, 'local-token'),
    },
    120_000,
  );
}, 400_000);

afterAll(async () => {
  await front?.stop();
  await rm(dir, { recursive: true, force: true });
});

/** 낮은 층 요청: Host 등 머리를 그대로 정할 수 있다 */
function rawGet(origin: string, pathname: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    http
      .get({ host: url.hostname, port: url.port, path: pathname, headers }, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('Rust 앞단 + 진짜 Node 서버', () => {
  it('헬스와 중첩 라우트를 앞단 너머로 준다', async () => {
    expect(await (await fetch(`${front!.origin}/api/health`)).json()).toMatchObject({ status: 'ok', app: 'b-studio' });
    expect(await (await fetch(`${front!.origin}/api/health/routes`)).json()).toEqual({ ok: true });
  });

  it('소켓 폴더는 0700이고 그 안에 소켓 하나가 있다', async () => {
    const { mode } = await import('node:fs').then((fs) => fs.statSync(runDir));
    expect(mode & 0o777).toBe(0o700);
    expect((await readdir(runDir)).filter((name) => name.endsWith('.sock'))).toHaveLength(1);
  });

  it('로컬 토큰 쿠키가 앞단을 거쳐도 인증이 같다(토큰 없는 요청은 403, 쿠키가 있으면 통과)', async () => {
    expect((await fetch(`${front!.origin}/api/terminals/stream?ids=`)).status).toBe(403);
    const token = (await readFile(path.join(dir, 'local-token'), 'utf8')).trim();
    const controller = new AbortController();
    const response = await fetch(`${front!.origin}/api/terminals/stream?ids=`, { headers: { cookie: `b_studio_local=${token}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('Host를 그대로 넘긴다: 이 컴퓨터의 주소가 아닌 Host는 Node가 이 컴퓨터의 주소로 보지 않는다', async () => {
    const token = (await readFile(path.join(dir, 'local-token'), 'utf8')).trim();
    const local = await rawGet(front!.origin, '/api/agents', { host: new URL(front!.origin).host, cookie: `b_studio_local=${token}` });
    expect(local.status).toBe(200);
    // Host를 다시 쓰면(예: 127.0.0.1로) 이 요청이 로컬로 보여 통과한다. 그대로 넘기면 Node가 막는다
    const foreign = await rawGet(front!.origin, '/api/agents', { host: 'studio.example.com', cookie: `b_studio_local=${token}` });
    expect(foreign.status).not.toBe(200);
  });

  it('종료 신호를 받으면 Node를 닫고 0으로 끝나며 소켓을 남기지 않는다', async () => {
    await front!.stop();
    expect(front!.child.exitCode).toBe(0);
    expect(existsSync(runDir) ? (await readdir(runDir)).filter((name) => name.endsWith('.sock')) : []).toEqual([]);
  });
});
