import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLORE_QA_RUN_FILE, readExploreQaRunFile, writeExploreQaRunFile } from './explore-qa-run-file';
import type { ExploreQaRun } from './explore-qa-runs';

const done: ExploreQaRun = {
  id: 'explore-1',
  service: 'web',
  goal: { goal: '화면을 점검한다', startPath: '/live/1' },
  status: 'done',
  actions: [{ index: 1, tool: 'qa_navigate', input: { path: '/live/1' }, ok: true, newDiagnosticsCount: 0, url: 'http://127.0.0.1:1/live/1', at: 1 }],
  findings: [{ severity: 'major', summary: '로그인 줄이 잘립니다', observedAtAction: 1 }],
  expectedRejections: [{ actionIndex: 2, tool: 'qa_click', reason: '로그인 없이 주문', requests: [{ status: 401, url: 'http://127.0.0.1:1/api/orders' }] }],
  texts: ['점검을 마쳤습니다'],
  startedAt: 100,
  finishedAt: 200,
};

async function stateFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), 'explore-qa-run-')), EXPLORE_QA_RUN_FILE);
}

describe('끝난 탐색형 QA 실행을 파일로 남기고 다시 읽는다 (이슈 #602)', () => {
  it('남긴 실행을 그대로 읽는다(발견·예상된 거절·행동 기록 포함). 폴더가 없으면 만들고 임시 파일을 남기지 않는다', async () => {
    const file = await stateFile();
    await writeExploreQaRunFile(file, done);
    expect(await readExploreQaRunFile(file)).toEqual(done);
    expect(await readdir(path.dirname(file))).toEqual(['explore-qa-run.json']);
  });

  it('도는 중인 실행은 남기지 않는다(다시 띄운 뒤 "실행 중"으로 멈춘 기록이 보이지 않게)', async () => {
    const file = await stateFile();
    await writeExploreQaRunFile(file, { ...done, status: 'running' });
    expect(await readExploreQaRunFile(file)).toBeUndefined();
  });

  it('새로 끝난 실행이 앞의 것을 덮어쓴다', async () => {
    const file = await stateFile();
    await writeExploreQaRunFile(file, done);
    await writeExploreQaRunFile(file, { ...done, id: 'explore-2', findings: [] });
    expect((await readExploreQaRunFile(file))?.id).toBe('explore-2');
  });

  it('파일이 없거나 깨졌거나 형식이 다르면 읽지 않는다', async () => {
    const file = await stateFile();
    expect(await readExploreQaRunFile(file)).toBeUndefined();
    await writeExploreQaRunFile(file, done);
    const text = await readFile(file, 'utf8');

    await writeFile(file, text.slice(0, 40));
    expect(await readExploreQaRunFile(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ format: 999, run: done }));
    expect(await readExploreQaRunFile(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ format: 1, run: { ...done, status: 'running' } }));
    expect(await readExploreQaRunFile(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ format: 1, run: { ...done, actions: 'x' } }));
    expect(await readExploreQaRunFile(file)).toBeUndefined();
    await writeFile(file, JSON.stringify([done]));
    expect(await readExploreQaRunFile(file)).toBeUndefined();
  });
});
