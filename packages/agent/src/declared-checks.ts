import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import type { WorkflowSpec } from '@b-studio/spec';

/**
 * 확인 선언이 바뀌었는지 보는 판정은 Rust(crates/bstudio-guard/src/declared_checks.rs, ADR-191 3단계 3e)가 한다.
 * 여기는 값을 JSON으로 건네고 받는 껍데기다. 불러오지 못하거나 모양이 어긋난 선언이면 던진다 — TS로 대신 판정하는 길은 없다
 */

/** 게이트의 리뷰 단계에 남기는 "확인 선언이 바뀌었다" 기록의 이름 */
export const DECLARED_CHECKS_CHECK = 'declared-checks';

export interface DeclaredCheckChange {
  added: string[];
  removed: string[];
  changed: string[];
}

/** 없는 workflow는 JSON의 null이다 */
const encode = (workflow: WorkflowSpec | undefined): string => encodeNative(workflow ?? null);

/** 실행을 시작할 때의 선언과 지금 파일의 선언을 견준다. 실행 정책의 차이는 보지 않는다 */
export function diffDeclaredChecks(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): DeclaredCheckChange {
  return decodeNative<DeclaredCheckChange>(native.diffDeclaredChecks(encode(started), encode(latest)));
}

export function hasDeclaredCheckChange(change: DeclaredCheckChange): boolean {
  return native.hasDeclaredCheckChange(change.added, change.removed, change.changed);
}

/**
 * 실행을 시작할 때보다 지금 선언이 약해진 항목을 사람이 읽는 목록으로 돌려준다(#767). 확인 선언은 삭제·변경만 보고,
 * 실행 정책은 시작할 때 있던 값이 빠진 것을 본다. maxTurns는 보호가 아니므로 보지 않는다.
 */
export function weakenedDeclarations(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): string[] {
  return native.weakenedDeclarations(encode(started), encode(latest));
}

/** 예: "추가: 부하 orders-p95 · 삭제: 테스트 unit · 변경: 화면 web /cart" */
export function describeDeclaredCheckChange(change: DeclaredCheckChange): string {
  return native.describeDeclaredCheckChange(change.added, change.removed, change.changed);
}

/** 실행 정책은 시작할 때의 것을 그대로 두고, 확인 선언만 지금 파일의 것으로 바꾼 workflow */
export function withDeclaredChecks(started: WorkflowSpec | undefined, latest: WorkflowSpec | undefined): WorkflowSpec | undefined {
  const merged = native.withDeclaredChecks(encode(started), encode(latest));
  return merged === null || merged === undefined ? undefined : decodeNative<WorkflowSpec>(merged);
}
