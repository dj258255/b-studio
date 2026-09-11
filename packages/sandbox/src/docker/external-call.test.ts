import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { externalCallScript } from './external-call';

const EDGE_SOURCE = readFile(new URL('../../edge/edge.mjs', import.meta.url), 'utf8');

/** 컨테이너에서처럼 표준 입력으로 받은 모듈을 실행한다 */
function runScript(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-'], { env, timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(script);
  });
}

const lastJson = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;

describe('externalCallScript', () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it('edge 서버를 띄우지 않고 studio 호출자로 정책·인증·가림을 적용해 마지막 줄에 결과를 낸다', async () => {
    const received: Array<string | undefined> = [];
    const upstream = http.createServer((request, response) => {
      received.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 1, phone: '010-1234-5678' }));
    });
    servers.push(upstream);
    const port = await new Promise<number>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port)));

    const env = {
      PATH: process.env.PATH,
      // edge 컨테이너 환경에는 EDGE_MAIN=1이 있다. 스크립트가 서버 시작을 끄지 못하면 포트를 잡고 끝나지 않는다
      EDGE_MAIN: '1',
      EDGE_EXTERNALS: JSON.stringify([
        {
          name: 'legacy-users',
          baseUrl: `http://127.0.0.1:${port}`,
          policy: {
            allow: [{ callers: ['studio'], methods: ['GET'], paths: ['/api/users/*'] }],
            mask: ['phone'],
            auth: { header: 'Authorization', secret: 'LEGACY_USERS_TOKEN', prefix: 'Bearer ' },
          },
        },
      ]),
      LEGACY_USERS_TOKEN: 'tok_live_1234567890',
    };
    const edge = await EDGE_SOURCE;

    const allowed = await runScript(externalCallScript(edge, { name: 'legacy-users', via: 'agent', method: 'GET', path: '/api/users/1' }), env);
    expect(allowed.code).toBe(0);
    expect(lastJson(allowed.stdout)).toMatchObject({ decision: 'allow', status: 200, masked: 1, body: '{"id":1,"phone":"[가림]"}' });
    expect(received).toEqual(['Bearer tok_live_1234567890']);

    const denied = await runScript(externalCallScript(edge, { name: 'legacy-users', via: 'explorer', method: 'DELETE', path: '/api/users/1' }), env);
    expect(lastJson(denied.stdout)).toMatchObject({ decision: 'deny', status: 403 });
    expect(received).toHaveLength(1);
  });
});
