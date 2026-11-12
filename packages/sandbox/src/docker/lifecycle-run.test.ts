import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import { ExecCheckedError } from '../exec-checked';
import { native } from '../native';
import type { NativeDestroyResult } from '../native';
import { destroySandbox, type DestroyContext } from './lifecycle-run';

/**
 * `destroySandbox` 껍데기가 Rust의 단계별 결과를 옛 `try/finally`와 같은 오류로 바꾸는지 본다(ADR-195 4f A4c-3c).
 * 두 단계가 함께 실패했을 때 어느 오류가 던져지는지는 진짜 파일 시스템으로 만들기 어려워(Node와 Rust의 오류 글이 달라 가를 수 없다) Rust 결과를 흉내 내 고정한다.
 */

afterEach(() => vi.restoreAllMocks());

const ctx: DestroyContext = {
  id: 'studio-shop-a1b2c3',
  dockerBin: 'docker',
  env: {},
  project: { root: '/p', composePath: '/p/compose.yaml' },
  overridePath: '/w/o.yaml',
  redact: (text) => text,
  composeFailure: (command, result) => new SandboxError(`docker compose ${command} 실패`, result.stderr),
  workDir: '/tmp/b-studio-abc123',
  evaluationAssetRoot: '/assets',
};

const ok = { kind: 'ok' as const, message: '', stdout: '', stderr: '' };
const done = (patch: Partial<NativeDestroyResult>): NativeDestroyResult => ({ kind: 'done', downFailed: false, downStderr: '', images: ok, workDir: null, assets: null, ...patch });

async function failureOf(result: NativeDestroyResult): Promise<Error | undefined> {
  vi.spyOn(native, 'destroySandbox').mockResolvedValue(result);
  return destroySandbox(ctx).then(() => undefined, (error: unknown) => error as Error);
}

describe('destroySandbox의 오류 우선순위(옛 try/finally)', () => {
  it('모두 성공하면 던지지 않는다', async () => {
    expect(await failureOf(done({}))).toBeUndefined();
  });

  it('평가 자산 > 작업 폴더 > 이미지 > down', async () => {
    const images = { kind: 'failed' as const, message: 'Command failed: image rm\nconflict', code: 1, stdout: '', stderr: 'conflict' };
    const all = done({ downFailed: true, downStderr: 'down failed', images, workDir: 'work dir failed', assets: 'assets failed' });
    expect((await failureOf(all))?.message).toBe('assets failed');
    expect((await failureOf({ ...all, assets: null }))?.message).toBe('work dir failed');
    // down이 실패하면 이미지 단계는 돌지 않는다(Rust가 건너뛴다). 둘 다 와도 down이 이긴다
    const downError = await failureOf({ ...all, assets: null, workDir: null });
    expect(downError).toBeInstanceOf(SandboxError);
    expect(downError?.message).toContain('docker compose down 실패');
    const imageError = await failureOf(done({ images }));
    expect(imageError).toBeInstanceOf(ExecCheckedError);
    expect((imageError as ExecCheckedError).code).toBe(1);
  });

  it('id 꼴이 틀리면 옛 assertSandboxId와 같은 글로 던진다', async () => {
    expect((await failureOf({ ...done({}), kind: 'invalid-id' }))?.message).toBe('b-studio가 만든 샌드박스 id가 아닙니다: studio-shop-a1b2c3');
    expect((await failureOf(done({ images: { ...ok, kind: 'invalid-id' } })))?.message).toBe('b-studio가 만든 샌드박스 id가 아닙니다: studio-shop-a1b2c3');
  });

  it('출력 상한을 넘은 이미지 오류는 옛 execChecked의 코드를 쓴다', async () => {
    const error = await failureOf(done({ images: { kind: 'failed', message: 'maxBuffer length exceeded: docker image ls', stdout: '', stderr: '' } }));
    expect((error as ExecCheckedError).code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });
});
