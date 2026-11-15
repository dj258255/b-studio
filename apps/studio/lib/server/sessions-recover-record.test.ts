import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * 저장한 기록 하나를 세션 기록(ADR-203, Rust)에 올리지 못해도 다른 세션의 복구는 이어진다(B1a 커밋 보안 검토 지적).
 * 올리지 못하는 기록: `JSON.parse`는 읽지만 `JSON.stringify`가 재귀 깊이로 던지는 아주 깊은 중첩(손으로 고친 파일).
 *
 * 따로 둔 까닭: `recoverSessions()`는 프로세스마다 한 번만 디스크를 읽는다(sessions-recover-terminal.test.ts와 같다).
 * 진짜로 하는 것: 세션 폴더의 기록 읽기와 복구. 가짜로 바꾸는 것: 샌드박스 제공자와 터미널 정리(도커를 부르지 않는다)
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

async function persisted(root: string, id: string, pid: number, historyJson: string): Promise<void> {
  const dir = path.join(root, `proj-${id}`, '.git', 'b-studio');
  await mkdir(dir, { recursive: true });
  const rest = JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    owner: { pid },
    snapshot: { id, projectId: 'proj', projectName: 'proj', workDir: path.join(root, `proj-${id}`), status: 'stopped', mode: 'claude-code', running: false, services: [], checkpoints: [] },
    history: '@@HISTORY@@',
    conversation: [],
    demoIndex: 0,
    claudeCode: { notes: [] },
    sourceDirtyFiles: 0,
    sandbox: { id: `studio-proj-${id}`, provider: 'fake' },
  });
  await writeFile(path.join(dir, 'session.json'), rest.replace('"@@HISTORY@@"', historyJson));
}

describe('저장한 기록을 올리지 못한 세션', () => {
  it('그 세션만 건너뛰고 다른 세션은 복구한다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-recover-record-'));
    process.env.B_STUDIO_SESSIONS_DIR = root;
    const dead = spawnSync('true').pid!;
    const deep = `${'['.repeat(200_000)}1${']'.repeat(200_000)}`;
    await persisted(root, 'aaa111', dead, `[{"type":"notice","text":"깊은 값","value":${deep}}]`);
    await persisted(root, 'bbb222', dead, '[{"type":"run_started","runId":"r","request":"남은 세션"}]');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recoverSessions()).resolves.toBeUndefined();
    expect(getSnapshot('bbb222')?.status).toBe('stopped');
    expect(getSnapshot('aaa111')).toBeUndefined();
    expect(errors.mock.calls.some((call) => String(call[0]).includes('aaa111'))).toBe(true);
    errors.mockRestore();
  });
});
