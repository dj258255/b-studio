import { EDGE_IMAGE } from '../edge-config';
import { decodeNative, encodeNative, native } from '../native';
import type { LoadRequest, LoadResult } from '../types';

/**
 * 부하 러너 이미지. 샌드박스 출입구(edge)와 같은 이미지를 쓴다 — 샌드박스가 떠 있으면 이미 받아 둔 이미지라 새로 받지 않는다.
 * 전용 부하 도구 이미지를 쓰지 않은 까닭은 ADR-163에 적었다(가상 사용자마다 메모리를 쓰는 도구는 로컬 도커 VM에 부담이다)
 */
export const LOAD_RUNNER_IMAGE = EDGE_IMAGE;
/** 러너 컨테이너의 b-studio.service 라벨. compose 서비스가 아니라 일회용 컨테이너라 사용량 화면에는 나오지 않는다 */
export const LOAD_RUNNER_SERVICE = 'b-studio-load';
/** (Rust crates/bstudio-guard/src/load_runner.rs에도 같은 값이 있다. load-runner-differential 시험이 맞는지 본다) */
/** 요청 하나가 이 시간 안에 응답하지 않으면 응답을 받지 못한 요청으로 센다 */
export const LOAD_REQUEST_TIMEOUT_MS = 10_000;
/** 준비 요청과 재는 요청을 합친 전체 상한. 넘으면 남은 요청을 보내지 않고 끝낸다 */
export const LOAD_DEADLINE_MS = 60_000;

/**
 * 러너 스레드 수. 동시 연결이 많을수록 스레드를 늘리되, 도커가 쓸 수 있는 CPU의 절반을 넘지 않는다(재는 대상과 CPU를 다투지 않게).
 * 스레드 수만큼 --cpus를 준다. CPU 한도가 스레드 수보다 작으면 러너가 스로틀링에 걸려 응답 시간이 부풀려진다(트러블슈팅 128)
 */
export function loadThreads(concurrent: number, daemonCpus: number | undefined): number {
  return native.loadThreads(concurrent, daemonCpus);
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
  return native.loadRunArgs(plan.name, plan.network, plan.sandboxId, plan.threads, plan.runtime, LOAD_RUNNER_IMAGE);
}

/** 러너에 넘길 설정. 대상은 서비스 이름과 컨테이너 포트로만 정해진다 — 경로가 다른 호스트를 가리킬 방법이 없다 */
export function loadConfig(request: LoadRequest, target: { port: number; threads: number }): Record<string, unknown> {
  return decodeNative<Record<string, unknown>>(native.loadConfig(encodeNative(request), target.port, target.threads));
}

/** 설정을 스크립트 앞에 붙인다. JSON은 그대로 자바스크립트 값이라 따옴표를 따로 다루지 않는다 */
export function loadScript(runner: string, config: Record<string, unknown>): string {
  return native.loadScript(runner, JSON.stringify(config));
}

/**
 * 러너 출력의 마지막 줄을 읽는다. 꼴이 하나라도 어긋나면 undefined — 호출자가 "재지 못했다"로 다룬다.
 * 읽은 값끼리도 맞춰 본다: 받은 응답 수가 상태 코드별 합과 같아야 하고, 받은 응답과 받지 못한 요청의 합이 보낸 요청 수와 같아야 한다.
 * 덜 센 결과로 통과하는 일을 막는다
 */
export function parseLoadOutput(stdout: string, request: Pick<LoadRequest, 'requests' | 'concurrent'>): LoadResult | undefined {
  const parsed = native.parseLoadOutput(stdout, request.requests, request.concurrent);
  return parsed ? decodeNative<LoadResult>(parsed) : undefined;
}
