import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import type { LoadRequest, LoadResult } from '@b-studio/sandbox';
import type { LoadExpect, WorkflowLoadCheck } from '@b-studio/spec';

/**
 * 부하 확인의 통과 판정은 Rust(crates/bstudio-guard/src/load_check.rs, ADR-191 3단계 3e)가 한다. 여기는 값을 JSON으로 건네고 받는 껍데기다.
 * 판정을 못 하거나(모양이 어긋난 결과) 던지면 그 확인은 실패다 — 통과로 세지 않는다
 */

/** 부하 확인 한 번의 판정. note는 통과·실패와 상관없이 남기는 요약, problems가 비어야 통과다 */
export interface LoadJudgement {
  note: string;
  problems: string[];
  /** 통과했을 때 사람에게 보여 줄 근거. 판정에 쓴 값만 적는다 */
  evidence: string[];
}

/** studio.yaml의 선언을 러너에 넘길 요청으로 바꾼다. requests를 생략하면 연결마다 한 건이다 */
export function loadRequestFor(check: WorkflowLoadCheck): LoadRequest {
  return decodeNative<LoadRequest>(native.loadRequestFor(encodeNative(check)));
}

/** 응답 시간 기준을 사람이 읽는 한 줄로. 예: "p95 200ms 이하, 409 응답만" */
export function describeLoadExpect(expect: LoadExpect): string {
  return native.describeLoadExpect(encodeNative(expect));
}

/**
 * 러너가 잰 값으로 통과 여부를 정한다. 원인을 추정하지 않고 숫자만 남긴다.
 * 응답을 받지 못한 요청이 하나라도 있으면 실패다 — 느리거나 끊긴 요청이 표본에서 빠진 채 응답 시간만 보고 통과하지 않게 한다.
 * 응답 시간을 잴 응답이 없어도 실패다(기준을 확인하지 못한 것을 통과로 세지 않는다).
 * 서버 오류(5xx)도 allStatusIn에 적지 않았으면 실패다
 */
export function judgeLoad(check: WorkflowLoadCheck, result: LoadResult): LoadJudgement {
  return decodeNative<LoadJudgement>(native.judgeLoad(encodeNative(check), encodeNative(result)));
}
