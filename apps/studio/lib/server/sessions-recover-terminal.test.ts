import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * 스튜디오가 다시 떴을 때 이전 프로세스가 남긴 세션 터미널(에이전트 컨테이너와 관문 설정)을 치우는지 본다(이슈 #689).
 * 에이전트 컨테이너는 샌드박스(compose 프로젝트) 밖에 있어, 샌드박스를 내리는 정리로는 지워지지 않는다.
 *
 * 따로 둔 까닭: `recoverSessions()`는 프로세스마다 한 번만 디스크를 읽는다(sessions-delete-guard.test.ts와 같다).
 * 진짜로 하는 것: 세션 폴더의 기록 읽기와 복구 순서. 가짜로 바꾸는 것: 샌드박스 제공자와 터미널 정리(도커를 부르지 않는다)
 */
const fake = vi.hoisted(() => ({ cleaned: [] as string[], disposed: [] as Array<[string, string]> }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  return {
    ...actual,
    providerFromEnv: () => ({
      name: 'fake',
      isolation: undefined,
      create: async () => {
        throw new Error('이 테스트는 샌드박스를 만들지 않는다');
      },
      cleanup: async (sandboxId: string) => {
        fake.cleaned.push(sandboxId);
      },
    }),
  };
});
vi.mock('./session-terminal', () => ({
  disposeSessionTerminal: async (sessionId: string, sandboxId: string) => {
    fake.disposed.push([sessionId, sandboxId]);
  },
  interruptSessionTerminal: () => {},
  noteSessionTerminalCli: () => {},
  removeTerminalLeftovers: async () => {},
}));

import { getSnapshot, recoverSessions } from './sessions';

const saved = { sessions: process.env.B_STUDIO_SESSIONS_DIR };
afterAll(() => {
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
});

async function persisted(root: string, id: string, status: 'ready' | 'idle' | 'stopped', pid: number, sandboxId = `studio-proj-${id}`): Promise<void> {
  const dir = path.join(root, `proj-${id}`, '.git', 'b-studio');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'session.json'),
    JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      owner: { pid },
      snapshot: { id, projectId: 'proj', projectName: 'proj', workDir: path.join(root, `proj-${id}`), status, mode: 'claude-code', running: false, services: [], checkpoints: [] },
      history: [],
      conversation: [],
      demoIndex: 0,
      claudeCode: { notes: [] },
      sourceDirtyFiles: 0,
      sandbox: { id: sandboxId, provider: 'fake' },
    }),
  );
}

describe('이전 프로세스가 남긴 세션 터미널의 정리', () => {
  it('끼어든 세션과 샌드박스를 켜지 않은(idle) 세션의 터미널을 치우고, 멈춘 세션은 건드리지 않는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-recover-terminal-'));
    process.env.B_STUDIO_SESSIONS_DIR = root;
    // 이미 끝난 프로세스가 남긴 세션으로 보이게 한다
    const dead = spawnSync('true').pid!;
    await persisted(root, 'aaa111', 'ready', dead);
    await persisted(root, 'bbb222', 'idle', dead);
    await persisted(root, 'ccc333', 'stopped', dead);
    // 손상된 기록: 샌드박스 id가 b-studio의 꼴이 아니다(다른 프로젝트의 컨테이너 이름을 가리키게 조작된 경우)
    await persisted(root, 'ddd444', 'idle', dead, 'pay');

    await recoverSessions();
    const started = Date.now();
    while (fake.disposed.length < 2 && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
    // 뒤늦게 오는 정리가 없는지 조금 더 기다린다
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 켜져 있던 세션: 샌드박스를 내리고, 그 밖에 있는 터미널의 컨테이너도 치운다
    expect(fake.cleaned).toEqual(['studio-proj-aaa111']);
    expect([...fake.disposed].sort()).toEqual([
      ['aaa111', 'studio-proj-aaa111'],
      // idle 세션은 샌드박스가 없어도 터미널은 열려 있었을 수 있다
      ['bbb222', 'studio-proj-bbb222'],
    ]);
    // 꼴이 아닌 id로는 아무것도 지우지 않는다("pay-agent" 같은 남의 컨테이너를 건드리지 않는다)
    expect(fake.disposed.some(([sessionId]) => sessionId === 'ddd444')).toBe(false);
    // 세션의 기록은 모두 남아 이어서 작업할 수 있다
    for (const id of ['aaa111', 'bbb222', 'ccc333', 'ddd444']) expect(getSnapshot(id)).toBeDefined();
  });
});
