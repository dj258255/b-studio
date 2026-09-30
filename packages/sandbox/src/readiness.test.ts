import { describe, expect, it } from 'vitest';
import { crashLogExcerpt, decideReadiness, type ReadinessPolicy } from './readiness';
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
