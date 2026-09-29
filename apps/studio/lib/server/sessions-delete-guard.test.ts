import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteSession, getSnapshot, recoverSessions } from './sessions';

/**
 * `assertWithinSessionsRoot`(경로 조작 방어)만 시험한다. 이 파일을 따로 둔 이유: `recoverSessions()`는 프로세스마다
 * 한 번만 디스크를 읽고 그 뒤로는 결과를 그대로 재사용한다(sessions.ts의 `store.recovery` 메모). 다른 테스트가 먼저
 * `recoverSessions()`를 부르고 나면 이 파일의 세션 저장소 폴더는 다시 읽지 않아 손상된 기록을 찾지 못한다.
 * 이 파일을 이 모듈의 첫 `recoverSessions()` 호출로 만들기 위해 별도 파일(별도 워커 모듈 인스턴스)로 둔다.
 */

let root: string;
const saved = { sessions: process.env.B_STUDIO_SESSIONS_DIR };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-delete-guard-'));
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
});

afterAll(() => {
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
});

describe('세션 지우기의 경로 조작 방어', () => {
  it('세션 저장소 밖을 가리키는 손상된 기록은 지우지 않고 거부한다', async () => {
    // 실제 b-studio 데이터가 아니라, 세션 저장소 밖의 폴더를 가리키도록 손상된(또는 조작된) 기록을 흉내 낸다
    const outside = await mkdtemp(path.join(tmpdir(), 'b-studio-outside-'));
    await writeFile(path.join(outside, 'marker.txt'), '지우면 안 되는 파일');

    // recover()가 "다른(이미 끝난) 프로세스가 남긴 세션"으로 보게, 이미 끝난 프로세스의 pid를 쓴다
    const dead = spawnSync('true');
    const evilDir = path.join(process.env.B_STUDIO_SESSIONS_DIR!, 'evil-abc123', '.git', 'b-studio');
    await mkdir(evilDir, { recursive: true });
    await writeFile(
      path.join(evilDir, 'session.json'),
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        owner: { pid: dead.pid },
        snapshot: {
          id: 'abc123',
          projectId: 'evil',
          projectName: 'evil',
          workDir: outside,
          status: 'stopped',
          mode: 'api',
          running: false,
          services: [],
          checkpoints: [],
        },
        history: [],
        conversation: [],
        demoIndex: 0,
        claudeCode: { notes: [] },
        sourceDirtyFiles: 0,
        sandbox: { id: 'studio-evil', provider: 'fake' },
      }),
    );

    await recoverSessions();
    expect(getSnapshot('abc123')).toBeDefined();

    await expect(deleteSession('abc123')).rejects.toThrow(/세션 저장소 밖/);
    // 지우지 못했으니 기록도 그대로 남는다
    expect(getSnapshot('abc123')).toBeDefined();
    // 밖의 폴더는 손끝 하나 대지 않는다
    await expect(readFile(path.join(outside, 'marker.txt'), 'utf8')).resolves.toBe('지우면 안 되는 파일');
  });
});
