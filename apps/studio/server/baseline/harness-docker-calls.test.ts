import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDockerCalls } from './harness';

// 서버가 끝나며 따로 띄우는 정리 명령은 node가 늦게 떠 기록이 늦게 온다(#1333)
describe('가짜 docker 기록 읽기', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('감싸개가 불렸다고 적은 수만큼 기록이 올 때까지 기다린다(기록이 조용한 시간보다 늦게 와도)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bsb-calls-'));
    await writeFile(path.join(dir, 'docker-spawned.log'), 'x\nx\n');
    await writeFile(path.join(dir, 'docker-calls.jsonl'), '');
    const late = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await appendFile(path.join(dir!, 'docker-calls.jsonl'), `${JSON.stringify({ argv: ['compose', 'down'], sub: ['compose', 'down'], how: 'default' })}\n`);
      await appendFile(path.join(dir!, 'docker-calls.jsonl'), `${JSON.stringify({ argv: ['rm'], sub: ['rm'], how: 'default' })}\n`);
    })();
    const calls = await readDockerCalls(dir);
    await late;
    expect(calls.map((call) => call.sub.join(' '))).toEqual(['compose down', 'rm']);
  });

  it('불린 기록이 없으면(감싸개 전의 세계) 지금처럼 조용해질 때까지만 기다린다', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bsb-calls-'));
    await writeFile(path.join(dir, 'docker-calls.jsonl'), `${JSON.stringify({ argv: ['info'], sub: ['info'], how: 'default' })}\n`);
    expect((await readDockerCalls(dir)).length).toBe(1);
  });
});
