import { WorkflowPageCheckSchema, type WorkflowPageCheck } from '@b-studio/spec';
import { parseDocument, type YAMLSeq } from 'yaml';
import type { ExploreQaGoal, QaActionRecord } from './explore-qa';
import { toPageCheckSteps } from './explore-qa';

/**
 * 탐색 결과를 studio.yaml의 workflow.pageChecks 한 줄로 저장한다(설계안 §6.5).
 * 사람이 "이 흐름을 게이트 화면 확인으로 저장" 버튼을 눌렀을 때만 부른다 — b-studio는 평소 studio.yaml을
 * 스스로 고치지 않는다는 원칙(사람 모르게 바뀌지 않게) 때문에, 이 저장은 사람의 명시적 행동으로만 일어난다.
 */
export interface AppendPageCheckOptions {
  service: string;
  goal: ExploreQaGoal;
  actions: readonly QaActionRecord[];
  viewport?: { width: number; height: number };
}

export interface BuiltPageCheck {
  check: WorkflowPageCheck;
  /** steps로 바꾸지 못해 빠진 행동(사람이 확인할 수 있게 돌려준다) */
  skipped: Array<{ index: number; tool: string; reason: string }>;
}

/**
 * 탐색 기록에서 저장 가능한 WorkflowPageCheck를 만든다. confirmText가 있으면 expectText로, 없으면 검사만 하는
 * 화면 확인(진단 신호만 본다)으로 저장한다. steps가 스키마 상한(PAGE_STEPS_MAX)을 넘으면 zod 메시지 그대로 던진다.
 */
export function buildPageCheckFromExploreQa(options: AppendPageCheckOptions): BuiltPageCheck {
  const { steps, skipped } = toPageCheckSteps(options.actions);
  const draft = {
    service: options.service,
    path: options.goal.startPath,
    mode: 'browser' as const,
    ...(options.goal.confirmText ? { expectText: options.goal.confirmText } : {}),
    ...(steps.length > 0 ? { steps } : {}),
    ...(options.viewport ? { viewport: options.viewport } : {}),
    allowConsoleErrors: false,
    noHorizontalScroll: true,
  };
  const check = WorkflowPageCheckSchema.parse(draft);
  return { check, skipped };
}

/**
 * studio.yaml 텍스트에 pageCheck 하나를 더한 새 텍스트를 돌려준다. 'yaml' 패키지의 Document API로 기존 주석·
 * 들여쓰기를 최대한 보존한다(완전히 다시 쓰지 않는다). workflow·pageChecks 키가 없으면 새로 만든다.
 */
export function appendPageCheckToYaml(yamlText: string, check: WorkflowPageCheck): string {
  const doc = parseDocument(yamlText);
  if (!doc.hasIn(['workflow', 'pageChecks'])) doc.setIn(['workflow', 'pageChecks'], []);
  const seq = doc.getIn(['workflow', 'pageChecks'], true) as YAMLSeq;
  seq.add(doc.createNode(check));
  return doc.toString();
}
