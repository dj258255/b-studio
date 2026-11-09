import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { native } from './native';

// 배포의 개별 I/O(2c-5, #1049). 임시 폴더와 127.0.0.1의 임시 포트만 쓴다.
let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bstudio-deploy-io-'));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(dir, { recursive: true, force: true });
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

describe('freePort', () => {
  it('바로 다시 묶을 수 있는 포트를 돌려준다', async () => {
    const port = await native.freePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const server = createTcpServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
    });
  });
});

describe('배포 잠금', () => {
  it('잡으면 0, 쥐고 있는 동안은 이 프로세스의 pid, 풀면 다시 잡는다', async () => {
    const lock = path.join(dir, 'state', 'deploy.lock');
    expect(await native.acquireDeployLock(lock)).toBe(0);
    expect(await readFile(lock, 'utf8')).toBe(String(process.pid));
    expect(await native.acquireDeployLock(lock)).toBe(process.pid);
    await native.releaseDeployLock(lock);
    expect(await native.acquireDeployLock(lock)).toBe(0);
  });

  it('죽은 프로세스의 잠금은 넘겨받는다', async () => {
    const lock = path.join(dir, 'deploy.lock');
    // 존재하지 않는 pid(상한을 넘는 값은 어떤 시스템에서도 쓰이지 않는다)
    await writeFile(lock, '2147483646');
    expect(await native.acquireDeployLock(lock)).toBe(0);
    expect(await readFile(lock, 'utf8')).toBe(String(process.pid));
  });

  it('읽을 수 없는 내용의 잠금도 넘겨받는다', async () => {
    const lock = path.join(dir, 'deploy.lock');
    for (const content of ['', 'abc', '0', '-5']) {
      await writeFile(lock, content);
      expect(await native.acquireDeployLock(lock)).toBe(0);
      await native.releaseDeployLock(lock);
    }
  });

  it('풀 때 파일이 없어도 던지지 않는다', async () => {
    await expect(native.releaseDeployLock(path.join(dir, '없음'))).resolves.toBeUndefined();
  });
});

describe('상태·compose 파일', () => {
  it('없는 파일은 null, 있으면 문자열', async () => {
    expect(await native.readTextFile(path.join(dir, '없음.json'))).toBeNull();
    await writeFile(path.join(dir, 'a.txt'), '안녕');
    expect(await native.readTextFile(path.join(dir, 'a.txt'))).toBe('안녕');
  });

  it('쓰기는 부모 폴더를 만들고 덮어쓴다', async () => {
    const file = path.join(dir, 'a', 'b', 'c.yaml');
    await native.writeTextFile(file, 'one');
    await native.writeTextFile(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
  });

  it('원자적 쓰기는 임시 파일을 남기지 않는다', async () => {
    const file = path.join(dir, 'x', 'state.json');
    await native.writeTextFileAtomic(file, '{}\n');
    await native.writeTextFileAtomic(file, '{"a":1}\n');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}\n');
    expect(await readdir(path.dirname(file))).toEqual(['state.json']);
  });

  it('쓰지 못하면 거절한다', async () => {
    await writeFile(path.join(dir, '파일'), 'x');
    await expect(native.writeTextFile(path.join(dir, '파일', 'a'), 'x')).rejects.toThrow(/파일을 쓰지 못했습니다/);
  });
});

describe('운영 주소 확인 한 번', () => {
  it('상태 코드를 돌려주고 리다이렉트를 따르지 않는다', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    expect(await native.probeHttpStatus(port, '/', 2_000)).toEqual({ status: 302 });
  });

  it('경로와 Host를 서버가 본 대로 보낸다', async () => {
    let seen = '';
    const port = await listen((req, res) => {
      seen = `${req.url} ${req.headers.host}`;
      res.writeHead(204);
      res.end();
    });
    expect(await native.probeHttpStatus(port, '/health?x=1#frag', 2_000)).toEqual({ status: 204 });
    expect(seen).toBe(`/health?x=1 127.0.0.1:${port}`);
  });

  it('닫힌 포트는 던지지 않고 error를 준다', async () => {
    const port = await native.freePort();
    const result = await native.probeHttpStatus(port, '/', 2_000);
    expect(result.status ?? null).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('응답이 없으면 시간 초과로 error를 준다', async () => {
    const port = await listen(() => {});
    const result = await native.probeHttpStatus(port, '/', 200);
    expect(result.error).toMatch(/시간/);
  });

  it('범위를 벗어난 포트도 던지지 않는다', async () => {
    const result = await native.probeHttpStatus(70_000, '/', 200);
    expect(result.error).toBeTruthy();
  });
});
