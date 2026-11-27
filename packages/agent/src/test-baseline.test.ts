import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecResult } from '@b-studio/sandbox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingChange } from './checkpoints';
import { BASELINE_READY_MARK, baselineFromCheckpoints, MAX_BASELINE_BYTES, runAtBaseline, type BaselineFile, type BaselineSnapshot } from './test-baseline';

/**
 * 컨테이너 안에서 도는 스크립트를 로컬 `sh`로 그대로 돌려 본다. 작업 폴더는 임시 폴더, TMPDIR도 임시 폴더라 복사본이 남았는지 셀 수 있다.
 * (`sandbox.exec`의 가짜: 서비스 컨테이너의 작업 폴더 = `work`)
 */
let root: string;
let work: string;
let scratch: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'baseline-'));
  work = path.join(root, 'work');
  scratch = path.join(root, 'tmp');
  outside = path.join(root, 'outside');
  await Promise.all([mkdir(work), mkdir(scratch), mkdir(outside)]);
});
afterEach(() => rm(root, { recursive: true, force: true }));

function shellExec(): { exec: (service: string, command: string[], options?: { input?: string; signal?: AbortSignal }) => Promise<ExecResult> } {
  return {
    exec: (_service, command, options) =>
      new Promise((resolve, reject) => {
        const child = spawn(command[0]!, command.slice(1), { cwd: work, env: { ...process.env, TMPDIR: scratch }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += String(chunk)));
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('error', reject);
        child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
        child.stdin.on('error', () => {});
        child.stdin.end(options?.input ?? '');
      }),
  };
}

const file = (name: string, content: string | null, executable = false): BaselineFile => ({ path: name, content: content === null ? null : Buffer.from(content), executable });
const ok = (...files: BaselineFile[]): BaselineSnapshot => ({ kind: 'ok', files });
const run = (snapshot: BaselineSnapshot, command: string[]) => runAtBaseline(shellExec(), 'api', command, snapshot, { timeoutMs: 20_000 });

describe('변경 전 나무에서 시험 돌리기(컨테이너 안 스크립트)', () => {
  it('바뀐 파일만 기준의 내용으로 되돌려 돌고, 새로 만든 파일은 지우고, 지운 파일은 되살리며, 작업 복사본은 그대로 둔다', async () => {
    await mkdir(path.join(work, 'src'));
    await writeFile(path.join(work, 'src/a.txt'), '지금 내용');
    await writeFile(path.join(work, 'src/new.txt'), '새로 만듦');
    await writeFile(path.join(work, 'untouched.txt'), '그대로');
    // 줄바꿈과 공백이 들어간 이름·내용도 그대로 간다
    await writeFile(path.join(work, 'sp ace.txt'), '지금');
    const snapshot = ok(file('src/a.txt', '변경 전 내용'), file('src/new.txt', null), file('src/deleted.txt', '지웠던 것'), file('sp ace.txt', 'x\n  y\n'));
    const script = 'test "$(cat src/a.txt)" = "변경 전 내용" && test ! -e src/new.txt && test "$(cat src/deleted.txt)" = "지웠던 것" && test "$(cat untouched.txt)" = 그대로 && test "$(cat "sp ace.txt")" = "$(printf "x\\n  y")"';

    expect(await run(snapshot, ['sh', '-c', script])).toEqual({ label: 'now' });
    // 호스트(= 작업 복사본)는 바뀌지 않았다
    expect(await readFile(path.join(work, 'src/a.txt'), 'utf8')).toBe('지금 내용');
    expect(await readFile(path.join(work, 'src/new.txt'), 'utf8')).toBe('새로 만듦');
    await expect(lstat(path.join(work, 'src/deleted.txt'))).rejects.toThrow();
    expect(await readFile(path.join(work, 'sp ace.txt'), 'utf8')).toBe('지금');
    // 복사본은 시험이 끝나면 지워진다
    expect(await readdir(scratch)).toEqual([]);
  });

  it('변경 전에도 실패하면 before, 변경 전에는 통과하면 now', async () => {
    await writeFile(path.join(work, 'flag'), 'broken');
    const snapshot = ok(file('flag', 'fine'));
    expect(await run(snapshot, ['sh', '-c', 'test "$(cat flag)" = fine'])).toEqual({ label: 'now' });
    expect(await run(ok(file('flag', 'broken')), ['sh', '-c', 'test "$(cat flag)" = fine'])).toEqual({ label: 'before' });
    expect(await readdir(scratch)).toEqual([]);
  });

  it('실행 비트를 기준대로 복원한다', async () => {
    await writeFile(path.join(work, 'run.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(work, 'run.sh'), 0o644);
    expect(await run(ok(file('run.sh', '#!/bin/sh\nexit 0\n', true)), ['./run.sh'])).toEqual({ label: 'now' });
    expect((await lstat(path.join(work, 'run.sh'))).mode & 0o111).toBe(0);
  });

  it('작업 폴더의 링크를 따라가 원본을 쓰지 않는다: 파일 링크는 링크만 바꾸고, 링크 안 폴더를 지나는 경로는 시험을 돌리지 않고 모름이다', async () => {
    await writeFile(path.join(outside, 'secret.txt'), '밖의 파일');
    await mkdir(path.join(outside, 'dir'));
    await symlink(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
    await symlink(path.join(outside, 'dir'), path.join(work, 'linkdir'));

    // 링크 자체가 바뀐 경로: 링크를 지우고 그 자리에 쓴다(링크 너머를 쓰지 않는다)
    expect(await run(ok(file('link.txt', '덮어쓴 내용')), ['sh', '-c', 'test "$(cat link.txt)" = "덮어쓴 내용"'])).toEqual({ label: 'now' });
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('밖의 파일');
    expect((await lstat(path.join(work, 'link.txt'))).isSymbolicLink()).toBe(true);

    // 링크 폴더를 지나는 경로: 쓰지 않고 시험도 돌리지 않는다
    const through = await run(ok(file('linkdir/x.txt', '쓰면 안 됨')), ['sh', '-c', 'exit 1']);
    expect(through).toEqual({ label: 'unknown', reason: 'setup-failed' });
    expect(await readdir(path.join(outside, 'dir'))).toEqual([]);
    expect(await readdir(scratch)).toEqual([]);
  });

  it('작업 폴더 밖을 가리키는 경로(절대 경로, ..)는 쓰지 않고 모름이다', async () => {
    for (const bad of ['/etc/b-studio-baseline-test', '../outside/pwn.txt', 'a/../../outside/pwn.txt', '..']) {
      expect(await run(ok(file(bad, 'x')), ['sh', '-c', 'exit 1']), bad).toEqual({ label: 'unknown', reason: 'setup-failed' });
    }
    expect(await readdir(outside)).toEqual([]);
  });

  it('시험 명령의 인자는 셸 문자열로 잇지 않는다', async () => {
    const hostile = `x; touch ${path.join(outside, 'injected')}`;
    expect(await run(ok(), ['sh', '-c', 'test "$1" = "$2"', 'sh', hostile, hostile])).toEqual({ label: 'now' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('시험이 돌았다는 표시가 없으면(셸이 시험 전에 멈춤) 그 종료 코드를 시험의 것으로 읽지 않는다', async () => {
    const result = await runAtBaseline({ exec: async () => ({ exitCode: 1, stdout: '', stderr: 'cp: 공간 부족' }) }, 'api', ['t'], ok(), { timeoutMs: 1000 });
    expect(result).toEqual({ label: 'unknown', reason: 'setup-failed' });
    // 표시는 출력의 맨 앞에서만 인정한다. 시험이 흉내 낸 표시는 인정하지 않는다
    const spoof = await runAtBaseline({ exec: async () => ({ exitCode: 1, stdout: `앞\n${BASELINE_READY_MARK}\n`, stderr: '' }) }, 'api', ['t'], ok(), { timeoutMs: 1000 });
    expect(spoof).toEqual({ label: 'unknown', reason: 'setup-failed' });
  });

  it('명령을 찾지 못하거나 실행하지 못한 종료 코드(126·127)는 변경 전에도 실패로 읽지 않는다', async () => {
    expect(await run(ok(), ['./does-not-exist.sh'])).toEqual({ label: 'unknown', reason: 'setup-failed' });
    await writeFile(path.join(work, 'plain.sh'), 'exit 1\n');
    expect(await run(ok(), ['./plain.sh'])).toEqual({ label: 'unknown', reason: 'setup-failed' });
  });

  it('기준을 못 모았으면 이유를 그대로 모름으로 돌려주고 컨테이너에 아무것도 부르지 않는다', async () => {
    let called = 0;
    const sandbox = { exec: async (): Promise<ExecResult> => (called++, { exitCode: 0, stdout: '', stderr: '' }) };
    expect(await runAtBaseline(sandbox, 'api', ['t'], { kind: 'unknown', reason: 'untracked-changes' }, { timeoutMs: 1000 })).toEqual({ label: 'unknown', reason: 'untracked-changes' });
    expect(await runAtBaseline(sandbox, 'api', [], ok(), { timeoutMs: 1000 })).toEqual({ label: 'unknown', reason: 'setup-failed' });
    expect(called).toBe(0);
  });

  it('실행이 던지면 취소·시간 초과·샌드박스 문제를 가려 모름이다', async () => {
    const aborting = new AbortController();
    aborting.abort();
    const throwing = { exec: async (): Promise<ExecResult> => Promise.reject(new Error('끊김')) };
    expect(await runAtBaseline(throwing, 'api', ['t'], ok(), { timeoutMs: 1000 })).toEqual({ label: 'unknown', reason: 'platform' });
    expect(await runAtBaseline(throwing, 'api', ['t'], ok(), { timeoutMs: 1000, signal: aborting.signal })).toEqual({ label: 'unknown', reason: 'aborted' });
    const hanging = { exec: (_service: string, _command: string[], options?: { signal?: AbortSignal }) => new Promise<ExecResult>((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('중단')))) };
    expect(await runAtBaseline(hanging, 'api', ['t'], ok(), { timeoutMs: 20 })).toEqual({ label: 'unknown', reason: 'timeout' });
  });
});

describe('체크포인트에서 기준 모으기', () => {
  const blob = (content: string, executable = false) => ({ kind: 'file' as const, content: Buffer.from(content), executable });
  const store = (changes: PendingChange[], blobs: Record<string, ReturnType<typeof blob> | { kind: 'missing' } | { kind: 'unsupported'; mode: string }>, excluded: string[] = []) => ({
    pendingChanges: async () => changes,
    blobAt: async (file: string, ref: string) => {
      expect(ref).toBe('abc123');
      return blobs[file] ?? { kind: 'missing' as const };
    },
    pendingExcludedFiles: async () => excluded,
  });

  it('바뀐 파일마다 서버가 아는 마지막 체크포인트의 내용(없었으면 null)을 모은다', async () => {
    const source = baselineFromCheckpoints(
      store([{ file: 'a.txt', change: 'modified' }, { file: 'new.txt', change: 'added' }, { file: 'gone.sh', change: 'deleted' }], { 'a.txt': blob('옛'), 'gone.sh': blob('#!/bin/sh', true) }),
      () => 'abc123',
    );
    expect(await source.load()).toEqual({
      kind: 'ok',
      files: [
        { path: 'a.txt', content: Buffer.from('옛'), executable: false },
        { path: 'new.txt', content: null, executable: false },
        { path: 'gone.sh', content: Buffer.from('#!/bin/sh'), executable: true },
      ],
    });
  });

  it('기준 체크포인트가 없거나, 되돌릴 수 없는 변경이 있거나, 너무 크거나, git이 실패하면 모름이다', async () => {
    const one: PendingChange[] = [{ file: 'a', change: 'modified' }];
    expect(await baselineFromCheckpoints(store(one, {}), () => undefined).load()).toEqual({ kind: 'unknown', reason: 'no-baseline' });
    expect(await baselineFromCheckpoints(store(one, {}, ['studio.yaml']), () => 'abc123').load()).toEqual({ kind: 'unknown', reason: 'untracked-changes' });
    expect(await baselineFromCheckpoints(store(one, { a: { kind: 'unsupported', mode: '120000' } }), () => 'abc123').load()).toEqual({ kind: 'unknown', reason: 'unsupported-file' });
    expect(await baselineFromCheckpoints(store(one, { a: blob('x'.repeat(MAX_BASELINE_BYTES + 1)) }), () => 'abc123').load()).toEqual({ kind: 'unknown', reason: 'too-large' });
    const many = Array.from({ length: 201 }, (_, index): PendingChange => ({ file: `f${index}`, change: 'modified' }));
    expect(await baselineFromCheckpoints(store(many, {}), () => 'abc123').load()).toEqual({ kind: 'unknown', reason: 'too-large' });
    const broken = { ...store(one, {}), pendingChanges: async (): Promise<PendingChange[]> => Promise.reject(new Error('git 실패')) };
    expect(await baselineFromCheckpoints(broken, () => 'abc123').load()).toEqual({ kind: 'unknown', reason: 'setup-failed' });
  });
});
