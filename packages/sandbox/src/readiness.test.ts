import { describe, expect, it } from 'vitest';
import { crashLogExcerpt, decideReadiness, isTransientBootError, shouldRetryTransientCrash, type ReadinessPolicy } from './readiness';
import type { ProbeResult } from './types';

const policy: ReadinessPolicy = { successThreshold: 2, timeoutMs: 10_000, intervalMs: 1_000 };

const refused = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  at: 0,
  ok: false,
  error: 'ECONNREFUSED',
  containerState: 'running',
  ...overrides,
});
const healthy = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  at: 0,
  ok: true,
  status: 200,
  containerState: 'running',
  ...overrides,
});

describe('decideReadiness', () => {
  it('기동 중 연결 거부는 기다린다', () => {
    expect(decideReadiness([refused(), refused()], policy, 3_000)).toEqual({ kind: 'waiting' });
  });

  it('연속 성공 횟수를 채워야 준비로 본다', () => {
    expect(decideReadiness([refused(), healthy()], policy, 3_000)).toEqual({ kind: 'waiting' });
    expect(decideReadiness([refused(), healthy(), healthy()], policy, 3_000)).toEqual({ kind: 'ready' });
  });

  it('중간에 실패하면 연속 성공을 다시 센다', () => {
    expect(decideReadiness([healthy(), refused({ status: 503, error: undefined }), healthy()], policy, 3_000)).toEqual({
      kind: 'waiting',
    });
  });

  it('컨테이너가 죽으면 타임아웃 전이라도 바로 실패한다', () => {
    const decision = decideReadiness([refused(), refused({ containerState: 'exited' })], policy, 2_000);
    expect(decision).toMatchObject({ kind: 'failed' });
    expect(decision.kind === 'failed' && decision.reason).toContain('exited');
  });

  it('restarting은 다시 살아날 수 있으므로 기다린다', () => {
    expect(decideReadiness([refused({ containerState: 'restarting' })], policy, 2_000)).toEqual({ kind: 'waiting' });
  });

  it('타임아웃이 지나면 마지막 확인 결과를 담아 실패한다', () => {
    const decision = decideReadiness([refused({ status: 503, error: undefined })], policy, 10_000);
    expect(decision).toEqual({ kind: 'failed', reason: '10초 안에 준비되지 않았습니다 (마지막 확인: HTTP 503, 컨테이너 running)' });
  });
});

describe('crashLogExcerpt', () => {
  it('스택 프레임은 빼고 원인이 적힌 줄을 고른다', () => {
    const lines = [
      'Picked up JAVA_TOOL_OPTIONS: -Dhttp.proxyHost=b-studio-edge',
      'Downloading https://services.gradle.org/distributions/gradle-8.14-bin.zip',
      'Exception in thread "main" java.io.IOException: Unable to tunnel through proxy. Proxy returns "HTTP/1.1 403 Forbidden"',
      '\tat java.base/sun.net.www.protocol.http.HttpURLConnection.doTunneling(HttpURLConnection.java:2311)',
      '\tat org.gradle.wrapper.Download.download(Download.java:67)',
    ];
    expect(crashLogExcerpt(lines)).toEqual(['Exception in thread "main" java.io.IOException: Unable to tunnel through proxy. Proxy returns "HTTP/1.1 403 Forbidden"']);
  });

  it('오류다운 줄이 없으면 마지막 몇 줄을 그대로 쓰고, 긴 줄은 자른다', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index}`);
    expect(crashLogExcerpt(lines, 3)).toEqual(['line 7', 'line 8', 'line 9']);
    expect(crashLogExcerpt(['x'.repeat(400)])[0]).toHaveLength(301);
    expect(crashLogExcerpt([])).toEqual([]);
  });
});

describe('isTransientBootError', () => {
  it('ETXTBSY가 있으면 일시 오류로 본다(트러블슈팅 #90, esbuild 설치 직후 자기 검증 경합)', () => {
    const lines = [
      'npm error code ETXTBSY',
      'npm error syscall spawnSync',
      'npm error path /workspace/frontend/node_modules/esbuild/bin/esbuild',
      'npm error ETXTBSY: text file is busy, spawnSync /workspace/frontend/node_modules/esbuild/bin/esbuild',
    ];
    expect(isTransientBootError(lines)).toBe(true);
  });

  it('EBUSY도 일시 오류로 본다', () => {
    expect(isTransientBootError(['Error: EBUSY: resource busy or locked, rename ...'])).toBe(true);
  });

  it('관련 없는 오류는 일시 오류로 보지 않는다', () => {
    expect(isTransientBootError(['Error: Cannot find module \'next\'', 'npm error code ENOENT'])).toBe(false);
    expect(isTransientBootError([])).toBe(false);
  });

  it('EBUSY·ETXTBSY를 부분 문자열로만 포함한 다른 단어는 오탐하지 않는다(단어 경계로 가른다)', () => {
    expect(isTransientBootError(['warning: EBUSYTOWN rate limit exceeded'])).toBe(false);
  });
});

describe('shouldRetryTransientCrash', () => {
  const etxtbsy = ['npm error ETXTBSY: text file is busy, spawnSync /workspace/frontend/node_modules/esbuild/bin/esbuild'];
  const unrelated = ['Error: Cannot find module \'next\''];

  it('1번째 시도가 일시 오류로 죽었으면 재시도한다', () => {
    expect(shouldRetryTransientCrash(1, etxtbsy)).toBe(true);
  });

  it('이미 한 번 재시도한 뒤(2번째 시도)는 같은 일시 오류가 다시 나도 더 재시도하지 않는다(상한 1회, 무한 재시도 금지)', () => {
    expect(shouldRetryTransientCrash(2, etxtbsy)).toBe(false);
    expect(shouldRetryTransientCrash(3, etxtbsy)).toBe(false);
  });

  it('일시 오류가 아니면 1번째 시도여도 재시도하지 않는다', () => {
    expect(shouldRetryTransientCrash(1, unrelated)).toBe(false);
  });
});
