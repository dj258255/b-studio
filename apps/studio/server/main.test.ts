import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 실제로 tsx로 서버를 띄워 몇 개를 부른다. 경로 별칭(@/), 라우트 지연 불러오기, 시작 때 로컬 토큰, SSE가 Next 없이 도는지 본다
 */
const repoRoot = path.resolve(import.meta.dirname, '../../..');
let child: ChildProcess | undefined;
let origin = '';
let home = '';

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'studio-server-'));
  child = spawn(path.join(repoRoot, 'node_modules/.bin/tsx'), ['--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/server/main.ts', '--port', '0'], {
    cwd: repoRoot,
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      HOME: home,
      B_STUDIO_MODE: 'demo',
      B_STUDIO_SESSIONS_DIR: path.join(home, 'sessions'),
      B_STUDIO_LOCAL_TOKEN_FILE: path.join(home, 'local-token'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버가 뜨지 않았습니다:\n${output}`)), 60_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const ready = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (ready) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${ready[1]}`);
      }
    };
    child!.stdout!.on('data', onData);
    child!.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child!.once('exit', (code) => reject(new Error(`서버가 끝났습니다(${code}):\n${output}`)));
  });
}, 70_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  await rm(home, { recursive: true, force: true });
});

describe('Node 서버(실제로 띄워 보기)', () => {
  it('헬스는 b-studio 표지를 주고 중첩 라우트도 답한다', async () => {
    expect(await (await fetch(`${origin}/api/health`)).json()).toMatchObject({ status: 'ok', app: 'b-studio' });
    expect(await (await fetch(`${origin}/api/health/routes`)).json()).toEqual({ ok: true });
  });

  it('시작할 때 로컬 토큰 파일을 만든다', async () => {
    expect((await readFile(path.join(home, 'local-token'), 'utf8')).trim()).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('desk가 부르는 관제 목록을 준다', async () => {
    const response = await fetch(`${origin}/api/agents`);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('items');
  });

  it('로컬 토큰 쿠키로 터미널 묶음 통로(SSE)를 연다', async () => {
    const token = (await readFile(path.join(home, 'local-token'), 'utf8')).trim();
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/terminals/stream?ids=`, { headers: { cookie: `b_studio_local=${token}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('토큰 없는 터미널 통로는 403', async () => {
    expect((await fetch(`${origin}/api/terminals/stream?ids=`)).status).toBe(403);
  });
});
