import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProjectFileSync, Workspace, writeNoFollowInside } from './workspace';

/**
 * 파일 시스템 I/O를 Rust로 옮기면서(ADR-195 4f A3) 옛 TS보다 엄격해진 곳. 옛 구현에서는 이 시험이 실패한다(고치기 전 실패 출력은 PR·ADR에 남겼다).
 * 모두 닫는 쪽으로만 달라졌다: 통과시키던 것을 거절하거나, 틈을 남기던 것을 남기지 않는다.
 */
let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'workspace-strict-'));
  outside = await mkdtemp(path.join(tmpdir(), 'workspace-strict-outside-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('보호 경로 고정은 처음 한 번만이다', () => {
  it('같은 파일을 동시에 두 번 쓰는 도구 호출 중 뒤의 것이 앞의 고정값을 덮어쓰지 못한다(옛 구현은 뒤의 호출이 고정값을 "이미 바뀜"으로 덮었다)', async () => {
    await writeFile(path.join(root, 'guard.txt'), 'original');
    const ws = new Workspace(root);
    ws.watchProtectedPaths(['guard.txt']);
    // 도구 밖 변경을 옮기는 자리(고정 직전의 await)를 호출마다 따로 열어, 앞의 쓰기가 끝난 뒤에 뒤의 고정이 이어지는 순서를 만든다
    const gates: Array<() => void> = [];
    ws.useOutsideSync(() => new Promise<void>((resolve) => gates.push(resolve)));
    const first = ws.write('guard.txt', 'tampered');
    const second = ws.write('guard.txt', 'tampered');
    await vi_waitFor(() => gates.length === 2);
    // 어느 호출이 먼저 고정 자리에 닿았는지는 정해져 있지 않다. 하나를 풀어 그것이 끝난 뒤에 나머지를 푼다
    gates[0]?.();
    await Promise.race([first, second]);
    gates[1]?.();
    await Promise.all([first, second]);
    // 바뀐 내용은 되돌린 것이 아니다
    expect(await readFile(path.join(root, 'guard.txt'), 'utf8')).toBe('tampered');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual([]);
    // 처음 쓰기 직전의 내용으로 되돌리면 되돌린 것으로 본다(고정값이 앞의 것으로 남아 있다)
    ws.useOutsideSync(async () => undefined);
    await ws.write('guard.txt', 'original');
    expect(ws.restoredProtectedFiles(['guard.txt'])).toEqual(['guard.txt']);
  });
});

describe('경로 확인이 끝난 뒤 상위 폴더가 바깥 링크로 바뀐 경우', () => {
  it('쓰기는 바깥에 빈 파일도 만들지 않는다(옛 구현은 O_CREAT가 바깥에 빈 파일을 만들고 나서 거절했다)', async () => {
    await symlink(outside, path.join(root, 'swapped'));
    await expect(writeNoFollowInside(root, path.join(root, 'swapped', 'new.txt'), 'x')).rejects.toThrow(/프로젝트 밖/);
    await expect(lstat(path.join(outside, 'new.txt'))).rejects.toThrow();
  });

  it('읽기는 안쪽을 가리키는 링크 폴더도 거치지 않는다(옛 구현은 실제 위치가 안쪽이고 같은 파일이면 열었다)', async () => {
    await mkdir(path.join(root, 'real'));
    await writeFile(path.join(root, 'real', 'a.txt'), 'a');
    await symlink(path.join(root, 'real'), path.join(root, 'alias'));
    const { readNoFollowInside } = await import('./workspace');
    await expect(readNoFollowInside(root, path.join(root, 'alias', 'a.txt'), 'alias/a.txt')).rejects.toThrow(/프로젝트 밖/);
  });
});

describe('깨진 링크 폴더', () => {
  it('readProjectFileSync는 상위 폴더가 깨진 링크여도 링크라고 거절한다(옛 구현은 없는 파일로 읽었다)', async () => {
    await symlink(path.join(outside, 'nowhere'), path.join(root, 'docs'));
    expect(readProjectFileSync(root, 'docs/requirements.md')).toEqual({ kind: 'irregular', reason: '상위 폴더가 심볼릭 링크입니다' });
  });
});

describe('FIFO에 쓰기', () => {
  it('쓰는 쪽이 없는 FIFO는 여는 데서 멈추지 않고 거절한다(옛 구현은 쓰기가 영영 멈췄다)', async () => {
    execFileSync('mkfifo', [path.join(root, 'pipe.txt')]);
    const ws = new Workspace(root);
    const outcome = await Promise.race([
      ws.write('pipe.txt', 'x').then(
        () => 'wrote',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3000).unref()),
    ]);
    // 옛 구현처럼 쓰기가 멈춰 있으면 읽는 쪽을 열어 풀어 준다(시험 프로세스가 끝나게)
    try {
      closeSync(openSync(path.join(root, 'pipe.txt'), constants.O_RDONLY | constants.O_NONBLOCK));
    } catch {
      // 풀 필요가 없다
    }
    expect(outcome).toBe('rejected');
  }, 10_000);
});

async function vi_waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!condition()) throw new Error('조건이 충족되지 않았습니다');
}
