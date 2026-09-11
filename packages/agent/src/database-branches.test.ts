import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecResult, Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseBranches, normalizeDump } from './database-branches';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const project = {
  databases: [['db', { engine: 'postgres', database: 'app', user: 'app', dependents: ['api'] }]],
} as unknown as LoadedProject;

/** pg_dump가 돌려줄 덤프를 차례로 꺼내고, 모든 명령을 기록하는 가짜 샌드박스 */
function fakeSandbox(dumps: string[], failing: Partial<Record<string, ExecResult>> = {}) {
  const calls: Array<{ service: string; command: string[]; input?: string }> = [];
  const sandbox = {
    async exec(service: string, command: string[], options?: { input?: string }): Promise<ExecResult> {
      calls.push({ service, command, input: options?.input });
      const failure = failing[command[0]!];
      if (failure) return failure;
      if (command[0] === 'pg_dump') return { exitCode: 0, stdout: dumps.shift() ?? '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'db-branches-test-'));
});

const dump = (body: string, key: string) => `\\restrict ${key}\n-- PostgreSQL database dump\n${body}\n\\unrestrict ${key}\n`;

describe('DatabaseBranches', () => {
  it('체크포인트마다 덤프를 파일로 남긴다', async () => {
    const { sandbox, calls } = fakeSandbox([dump('CREATE TABLE orders ();', 'k1')]);
    const branches = new DatabaseBranches(sandbox, project, dir);

    expect(await branches.save(SHA_A)).toMatchObject([{ service: 'db', action: 'saved' }]);
    expect(await readFile(path.join(dir, 'db', `${SHA_A}.sql`), 'utf8')).toContain('CREATE TABLE orders');
    expect(calls[0]).toEqual({ service: 'db', command: ['pg_dump', '-U', 'app', '-d', 'app', '--no-owner', '--no-privileges'], input: undefined });
  });

  it('지금 상태가 체크포인트와 같으면 되돌리지 않고, 서비스도 재시작하지 않는다', async () => {
    // 무작위 키만 다른 덤프는 같은 상태로 본다
    const { sandbox, calls } = fakeSandbox([dump('CREATE TABLE orders ();', 'k1'), dump('CREATE TABLE orders ();', 'k2')]);
    const branches = new DatabaseBranches(sandbox, project, dir);
    await branches.save(SHA_A);

    expect(await branches.restore(SHA_A)).toMatchObject({ states: [{ service: 'db', action: 'unchanged' }], dependents: [] });
    expect(calls.map((call) => call.command[0])).toEqual(['pg_dump', 'pg_dump']);
  });

  it('바뀌었으면 데이터베이스를 다시 만들고 덤프를 넣은 뒤, 기대는 서비스를 알려 준다', async () => {
    const saved = dump('CREATE TABLE orders ();', 'k1');
    const { sandbox, calls } = fakeSandbox([saved, dump('CREATE TABLE orders (memo text);', 'k2')]);
    const branches = new DatabaseBranches(sandbox, project, dir);
    await branches.save(SHA_A);

    expect(await branches.restore(SHA_A)).toMatchObject({ states: [{ service: 'db', action: 'restored' }], dependents: ['api'] });
    const [recreate, load] = calls.slice(2);
    expect(recreate?.command).toEqual([
      'psql', '-U', 'app', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q',
      '-c', 'DROP DATABASE IF EXISTS "app" WITH (FORCE)',
      '-c', 'CREATE DATABASE "app" OWNER "app"',
    ]);
    expect(load).toEqual({ service: 'db', command: ['psql', '-U', 'app', '-d', 'app', '-v', 'ON_ERROR_STOP=1', '-q'], input: saved });
  });

  it('저장하지 못한 체크포인트는 되돌리지 못했다고 알린다', async () => {
    const { sandbox, calls } = fakeSandbox([]);
    const branches = new DatabaseBranches(sandbox, project, dir);

    expect(await branches.restore(SHA_B)).toMatchObject({ states: [{ service: 'db', action: 'missing' }], dependents: [] });
    expect(calls).toHaveLength(0);
  });

  it('덤프에 실패하면 이유를 남기고, 복원에 실패한 데이터베이스에 기대는 서비스도 재시작 대상에 넣는다', async () => {
    const failing = { exitCode: 1, stdout: '', stderr: 'pg_dump: error: connection to server failed\n' };
    const branches = new DatabaseBranches(fakeSandbox([], { pg_dump: failing }).sandbox, project, dir);
    expect(await branches.save(SHA_A)).toEqual([{ service: 'db', action: 'failed', detail: 'pg_dump: error: connection to server failed' }]);

    const saved = fakeSandbox([dump('a', 'k1'), dump('b', 'k2')], { psql: { exitCode: 3, stdout: '', stderr: 'ERROR: syntax error' } });
    const restoring = new DatabaseBranches(saved.sandbox, project, dir);
    await restoring.save(SHA_B);
    expect(await restoring.restore(SHA_B)).toMatchObject({ states: [{ action: 'failed', detail: 'ERROR: syntax error' }], dependents: ['api'] });
  });

  it('파일은 그대로여도 데이터가 바뀌었는지 알아본다', async () => {
    const { sandbox } = fakeSandbox([dump('INSERT 1', 'k1'), dump('INSERT 1', 'k2'), dump('INSERT 2', 'k3')]);
    const branches = new DatabaseBranches(sandbox, project, dir);
    await branches.save(SHA_A);

    expect(await branches.changedSince(SHA_A)).toBe(false);
    expect(await branches.changedSince(SHA_A)).toBe(true);
  });

  it('데이터베이스가 없는 프로젝트는 아무것도 하지 않는다', async () => {
    const { sandbox, calls } = fakeSandbox([]);
    const branches = new DatabaseBranches(sandbox, { databases: [] } as unknown as LoadedProject, dir);
    expect(branches.enabled).toBe(false);
    expect(await branches.save(SHA_A)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('normalizeDump', () => {
  it('무작위 키가 들어간 restrict 줄만 뺀다', () => {
    expect(normalizeDump('\\restrict abc\nSELECT 1;\n\\unrestrict abc\n')).toBe('SELECT 1;\n');
  });
});
