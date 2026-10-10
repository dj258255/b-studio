import { EDGE_IMAGE } from '../edge-config';
import type { LoadRequest, LoadResult, LatencySummary } from '../types';

/**
 * 부하 러너 이미지. 샌드박스 출입구(edge)와 같은 이미지를 쓴다 — 샌드박스가 떠 있으면 이미 받아 둔 이미지라 새로 받지 않는다.
 * 전용 부하 도구 이미지를 쓰지 않은 까닭은 ADR-163에 적었다(가상 사용자마다 메모리를 쓰는 도구는 로컬 도커 VM에 부담이다)
 */
export const LOAD_RUNNER_IMAGE = EDGE_IMAGE;
/** 러너 컨테이너의 b-studio.service 라벨. compose 서비스가 아니라 일회용 컨테이너라 사용량 화면에는 나오지 않는다 */
export const LOAD_RUNNER_SERVICE = 'b-studio-load';
/** 요청 하나가 이 시간 안에 응답하지 않으면 응답을 받지 못한 요청으로 센다 */
export const LOAD_REQUEST_TIMEOUT_MS = 10_000;
/** 준비 요청과 재는 요청을 합친 전체 상한. 넘으면 남은 요청을 보내지 않고 끝낸다 */
export const LOAD_DEADLINE_MS = 60_000;
/** 러너 스레드 상한. 스레드마다 CPU 하나를 준다 */
const MAX_LOAD_THREADS = 4;
/** 스레드 하나가 맡을 연결 수. 이보다 많으면 스레드를 나눈다 */
const CONNECTIONS_PER_THREAD = 250;

/**
 * 러너 스레드 수. 동시 연결이 많을수록 스레드를 늘리되, 도커가 쓸 수 있는 CPU의 절반을 넘지 않는다(재는 대상과 CPU를 다투지 않게).
 * 스레드 수만큼 --cpus를 준다. CPU 한도가 스레드 수보다 작으면 러너가 스로틀링에 걸려 응답 시간이 부풀려진다(트러블슈팅 128)
 */
export function loadThreads(concurrent: number, daemonCpus: number | undefined): number {
  const byLoad = Math.ceil(concurrent / CONNECTIONS_PER_THREAD);
  const byCpu = daemonCpus && daemonCpus > 0 ? Math.max(1, Math.floor(daemonCpus / 2)) : 1;
  return Math.max(1, Math.min(MAX_LOAD_THREADS, byLoad, byCpu));
}

export interface LoadRunPlan {
  /** 컨테이너 이름. 중단됐을 때 이 이름으로만 지운다 */
  name: string;
  /** 샌드박스의 internal 네트워크(compose가 만든 실제 이름) */
  network: string;
  sandboxId: string;
  threads: number;
  /** 샌드박스 컨테이너에 쓰는 Docker 런타임(gVisor 등). 서비스와 같은 격리로 돌린다 */
  runtime?: string;
}

/**
 * 러너 컨테이너의 `docker run` 인자. 스크립트는 표준 입력으로 넘기므로 마운트가 없다.
 * internal 네트워크에만 붙여 샌드박스 밖으로 나가지 못하고, 파일 시스템은 읽기 전용이며 권한을 모두 내려놓는다.
 * 이미지는 새로 받지 않는다(--pull never) — 확인 도중에 네트워크에서 무언가를 받는 일이 없게 한다
 */
export function loadRunArgs(plan: LoadRunPlan): string[] {
  return [
    'run', '--rm', '--interactive', '--pull', 'never',
    '--name', plan.name,
    '--label', `b-studio.sandbox=${plan.sandboxId}`,
    '--label', `b-studio.service=${LOAD_RUNNER_SERVICE}`,
    '--network', plan.network,
    '--cpus', String(plan.threads),
    '--memory', '512m',
    '--pids-limit', '256',
    '--ulimit', 'nofile=4096:4096',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65534:65534',
    ...(plan.runtime ? ['--runtime', plan.runtime] : []),
    LOAD_RUNNER_IMAGE,
    'node', '--input-type=module', '-',
  ];
}

/** 러너에 넘길 설정. 대상은 서비스 이름과 컨테이너 포트로만 정해진다 — 경로가 다른 호스트를 가리킬 방법이 없다 */
export function loadConfig(request: LoadRequest, target: { port: number; threads: number }): Record<string, unknown> {
  return {
    host: request.service,
    port: target.port,
    method: request.method,
    path: request.path,
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    requests: request.requests,
    concurrent: request.concurrent,
    warmup: request.warmup ?? 0,
    ...(request.latencyOf ? { latencyOf: [...request.latencyOf] } : {}),
    threads: target.threads,
    requestTimeoutMs: LOAD_REQUEST_TIMEOUT_MS,
    deadlineMs: LOAD_DEADLINE_MS,
  };
}

/** 설정을 스크립트 앞에 붙인다. JSON은 그대로 자바스크립트 값이라 따옴표를 따로 다루지 않는다 */
export function loadScript(runner: string, config: Record<string, unknown>): string {
  return `globalThis.B_STUDIO_LOAD = ${JSON.stringify(config)};\n${runner}`;
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function counts(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, amount]) => isCount(amount)) ? (Object.fromEntries(entries) as Record<string, number>) : undefined;
}

function latency(value: unknown): LatencySummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { count, p50, p95, p99, max } = value as Record<string, unknown>;
  if (!isCount(count)) return undefined;
  if (count === 0) return { count };
  return isMs(p50) && isMs(p95) && isMs(p99) && isMs(max) ? { count, p50, p95, p99, max } : undefined;
}

/**
 * 러너 출력의 마지막 줄을 읽는다. 꼴이 하나라도 어긋나면 undefined — 호출자가 "재지 못했다"로 다룬다.
 * 읽은 값끼리도 맞춰 본다: 받은 응답 수가 상태 코드별 합과 같아야 하고, 받은 응답과 받지 못한 요청의 합이 보낸 요청 수와 같아야 한다.
 * 덜 센 결과로 통과하는 일을 막는다
 */
export function parseLoadOutput(stdout: string, request: Pick<LoadRequest, 'requests' | 'concurrent'>): LoadResult | undefined {
  const last = stdout.trim().split('\n').at(-1);
  if (!last) return undefined;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(last);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    parsed = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const statuses = counts(parsed.statuses);
  const errors = counts(parsed.errors);
  const measured = latency(parsed.latency);
  const connect = latency(parsed.connect);
  const loopDelay = parsed.loopDelay as Record<string, unknown> | undefined;
  const warmup = parsed.warmup as Record<string, unknown> | undefined;
  const connectErrors = (parsed.connect as Record<string, unknown> | undefined)?.errors;
  if (!statuses || !errors || !measured || !connect || !isCount(connectErrors)) return undefined;
  if (!isCount(parsed.completed) || !isCount(parsed.threads) || !isMs(parsed.elapsedMs)) return undefined;
  if (!loopDelay || !isMs(loopDelay.p99) || !isMs(loopDelay.max)) return undefined;
  if (!warmup || !isCount(warmup.requests) || !isCount(warmup.errors)) return undefined;
  if (parsed.requests !== request.requests || parsed.concurrent !== request.concurrent) return undefined;
  if (!Object.keys(statuses).every((status) => /^[1-5]\d\d$/.test(status))) return undefined;
  const responded = Object.values(statuses).reduce((sum, amount) => sum + amount, 0);
  const failed = Object.values(errors).reduce((sum, amount) => sum + amount, 0);
  if (responded !== parsed.completed || responded + failed !== request.requests) return undefined;
  if (measured.count > responded) return undefined;
  return {
    requests: request.requests,
    concurrent: request.concurrent,
    threads: parsed.threads,
    completed: parsed.completed,
    elapsedMs: parsed.elapsedMs,
    statuses,
    errors,
    latency: measured,
    connect: { ...connect, errors: connectErrors },
    loopDelay: { p99: loopDelay.p99, max: loopDelay.max },
    warmup: { requests: warmup.requests, errors: warmup.errors },
  };
}
