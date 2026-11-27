/**
 * 스크립트 제어 명령(studio ls·wait …)이 세션 상태를 읽는 순수 함수. 새 판정은 만들지 않는다 —
 * 스튜디오가 /api/agents에 준 state·terminal.waiting·gate를 이름만 붙여 가르고, 게이트 결과는 그대로 옮긴다.
 */
import type { DeskItem } from '../desk/types';

/** 종료 코드. USAGE와 문서(docs/getting-started.md)의 표와 같다 */
export const EXIT = {
  /** 성공, wait는 조건이 맞았다(게이트를 기다렸다면 통과) */
  ok: 0,
  /** 게이트 실패, 세션 오류, 스튜디오가 요청을 거절함 */
  failed: 1,
  /** 사용법이 틀렸다 */
  usage: 2,
  /** wait가 시간 안에 조건을 보지 못했다 */
  timeout: 3,
  /** 세션이 권한 확인 창에서 사람을 기다린다 */
  permission: 4,
  /** 세션이 질문·입력 요구에서 사람을 기다린다 */
  input: 5,
  /** 세션이 끝났다(멈춤·완료)는데 기다리던 조건이 아니다 */
  ended: 6,
  /** 스튜디오에 붙지 못했거나 인증이 거절됐다 */
  unreachable: 7,
  /** 그 세션·프로젝트가 없다(접두사가 여럿에 맞는 경우도 포함) */
  notFound: 8,
  /** send: 글을 보냈지만 CLI가 받았다는 확인을 하지 못했다 */
  unconfirmed: 9,
  /** wait --for gate: 쉬는 중인데 게이트 판정이 없다(질문·바뀐 것 없음 등) */
  noVerdict: 10,
} as const;

export type Phase = 'working' | 'idle' | 'input' | 'permission' | 'question' | 'done' | 'error' | 'booting' | 'dormant';

/** 세션 하나의 지금 모습. 사람을 기다리는 것(권한·질문·입력)이 작업 중보다 앞선다: 기다리는 동안에도 state는 working일 수 있다 */
export function phaseOf(item: DeskItem): Phase {
  const waiting = item.terminal?.waiting;
  if (item.state === 'error') return 'error';
  if (item.state === 'done' || item.state === 'stopped') return 'done';
  if (waiting === 'permission') return 'permission';
  if (waiting === 'question') return 'question';
  if (waiting === 'input') return 'input';
  if (item.state === 'booting') return 'booting';
  if (item.state === 'dormant') return 'dormant';
  if (item.state === 'working') return 'working';
  return 'idle';
}

export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  working: '작업 중',
  idle: '쉼(다음 요청 대기)',
  input: '입력 필요',
  permission: '권한 대기',
  question: '질문',
  done: '끝남',
  error: '오류',
  booting: '켜는 중',
  dormant: '잠듦',
};

export type GateState = 'verifying' | 'passed' | 'failed' | 'none';

export function gateOf(item: DeskItem): GateState {
  return item.gate?.state ?? 'none';
}

export const GATE_LABEL: Readonly<Record<GateState, string>> = {
  verifying: '검증 중',
  passed: '통과',
  failed: '실패',
  none: '판정 없음',
};

export const WAIT_TARGETS = ['idle', 'input', 'permission', 'done', 'gate', 'any'] as const;
export type WaitTarget = (typeof WAIT_TARGETS)[number];

export interface WaitVerdict {
  /** 이 종료 코드로 끝낸다 */
  code: number;
  reason: string;
  /** 쉬는 상태에서 나온 판정이다: 게이트가 막 끝나는 사이의 깜빡임을 피하려고 잠깐(settle) 그대로일 때만 확정한다 */
  settle: boolean;
}

/**
 * 기다리는 조건(target)에 대해 지금 상태가 무엇을 뜻하는지. 아직 기다려야 하면 undefined.
 * 권한·질문처럼 사람이 움직여야 하는 상태와 오류·끝남은 어떤 조건을 기다리든 바로 알린다(조용히 계속 기다리지 않는다).
 * 게이트가 실패했거나 판정이 없는데 "조건 맞음(0)"으로 끝내지 않는다: 쉼 상태에서 게이트가 실패면 1, gate를 기다렸는데 판정이 없으면 10이다.
 * 게이트가 검증 중이면 쉬는 것으로 보지 않는다
 */
export function judgeWait(item: DeskItem, target: WaitTarget): WaitVerdict | undefined {
  const phase = phaseOf(item);
  const gate = gateOf(item);
  const gateVerdict = (): WaitVerdict | undefined => {
    if (gate === 'passed') return { code: EXIT.ok, reason: '게이트 통과', settle: true };
    if (gate === 'failed') return { code: EXIT.failed, reason: item.reason ? `게이트 실패: ${item.reason}` : '게이트 실패', settle: true };
    if (gate === 'none') return { code: EXIT.noVerdict, reason: '게이트 판정이 없습니다(질문이거나 바뀐 것이 없는 요청)', settle: true };
    return undefined;
  };
  switch (phase) {
    case 'error':
      return { code: EXIT.failed, reason: '세션이 오류로 끝났습니다', settle: false };
    case 'done':
      if (target === 'done') return { code: EXIT.ok, reason: '세션이 끝났습니다', settle: false };
      if (target === 'gate' && gate !== 'verifying' && gate !== 'none') return { ...gateVerdict()!, settle: false };
      return { code: EXIT.ended, reason: '세션이 끝났습니다', settle: false };
    case 'permission':
      return target === 'permission' ? { code: EXIT.ok, reason: '권한 확인을 기다립니다', settle: false } : { code: EXIT.permission, reason: '권한 확인 창에서 기다립니다(studio keys로 답하세요)', settle: false };
    case 'question':
    case 'input':
      return target === 'input' ? { code: EXIT.ok, reason: phase === 'question' ? '질문을 기다립니다' : '입력을 기다립니다', settle: false } : { code: EXIT.input, reason: phase === 'question' ? '질문에서 기다립니다' : '입력 요구에서 기다립니다', settle: false };
    case 'idle':
      if (target === 'gate') return gateVerdict();
      if (target === 'idle' || target === 'any') {
        if (gate === 'verifying') return undefined;
        if (gate === 'failed') return { code: EXIT.failed, reason: item.reason ? `쉬는 중이지만 게이트가 실패했습니다: ${item.reason}` : '쉬는 중이지만 게이트가 실패했습니다', settle: true };
        return { code: EXIT.ok, reason: gate === 'passed' ? '쉬는 중(게이트 통과)' : '쉬는 중', settle: true };
      }
      return undefined;
    default:
      // working·booting·dormant: 아직이다
      return undefined;
  }
}

/** 세션 id를 고른다. 정확히 같은 id가 먼저이고, 아니면 접두사가 하나에만 맞을 때다 */
export function matchSession(items: readonly DeskItem[], ref: string): { item: DeskItem } | { error: string } {
  const sessions = items.filter((entry) => !entry.id.startsWith('plan:'));
  const exact = sessions.find((entry) => entry.id === ref);
  if (exact) return { item: exact };
  if (ref.length === 0) return { error: '세션 id가 비어 있습니다' };
  const prefixed = sessions.filter((entry) => entry.id.startsWith(ref));
  if (prefixed.length === 1) return { item: prefixed[0]! };
  if (prefixed.length > 1) return { error: `세션 id 접두사 ${ref}가 ${prefixed.length}개에 맞습니다. 더 길게 쓰세요` };
  return { error: `세션 ${ref}을(를) 찾을 수 없습니다` };
}
