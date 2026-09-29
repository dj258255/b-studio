/**
 * 개입 필요 알림의 순수 로직. 탭 제목 배지와 브라우저 알림이 무엇을 알릴지 여기서 정한다.
 *
 * 판정은 부수 효과 없이 두고 테스트한다. localStorage·Notification 접근은 헬퍼로 감싸 실패해도
 * 화면이 멈추지 않게 한다. 알림을 실제로 띄우는 일은 배지 컴포넌트가 한다.
 */
import type { AgentAttention, AgentItem } from './server/agents-overview';

/** 개입 사유 한국어. 작업 화면과 알림이 같은 문구를 쓰도록 여기 한 곳에서 정의한다 */
export const ATTENTION_LABEL: Record<AgentAttention, string> = {
  question: '답을 기다립니다',
  approval: '계획 승인을 기다립니다',
  gate_failed: '검증 실패',
  error: '오류',
  budget: '토큰 한도',
};

export function attentionLabel(attention: AgentAttention): string {
  return ATTENTION_LABEL[attention];
}

/** 한 번에 이 개수를 넘게 새로 개입이 필요해지면 하나로 묶어 알린다 */
export const BATCH_OVER = 3;

/** 같은 항목이 같은 사유로 계속 있으면 다시 알리지 않게 하는 키 */
export function attentionKey(item: Pick<AgentItem, 'kind' | 'id' | 'attention'>): string {
  return `${item.kind}:${item.id}:${item.attention ?? ''}`;
}

/**
 * 새로 개입이 필요해진 항목만 돌려준다.
 * 처음 불러올 때(prev가 undefined)는 화면을 처음 여는 것이라 알리지 않는다.
 * 같은 항목이 같은 사유로 계속 있으면 키가 prev에 있어 새 항목이 아니다(사유가 바뀌면 새 항목).
 */
export function diffAttention(prev: readonly AgentItem[] | undefined, next: readonly AgentItem[]): AgentItem[] {
  if (prev === undefined) return [];
  const known = new Set(prev.filter((item) => item.attention).map(attentionKey));
  return next.filter((item) => item.attention !== undefined && !known.has(attentionKey(item)));
}

/** 탭 제목 앞에 개입 필요 수를 붙인다. 0이면 원래 제목 그대로 */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

export interface AttentionNotice {
  /** 알림 제목 */
  title: string;
  /** 누르면 이동할 곳 */
  href: string;
}

/** 새 항목의 알림. BATCH_OVER개 이하면 하나씩("{제목} — {사유}"), 넘으면 하나로 묶는다("개입 필요 N건") */
export function attentionNotices(items: readonly AgentItem[]): AttentionNotice[] {
  if (items.length === 0) return [];
  if (items.length > BATCH_OVER) return [{ title: `개입 필요 ${items.length}건`, href: '/work' }];
  return items.map((item) => ({ title: `${item.title} — ${item.attention ? attentionLabel(item.attention) : '개입 필요'}`.trim(), href: item.href }));
}

/** 알림 설정을 두는 localStorage 키 */
export const NOTIFY_STORAGE_KEY = 'b-studio:notify';

/** 알림을 켰는지. localStorage를 못 읽으면 꺼진 것으로 본다 */
export function readNotifyEnabled(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return storage?.getItem(NOTIFY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 알림 설정을 저장한다. 저장에 실패해도(사생활 보호 모드 등) 이번 세션에는 호출자가 상태로 반영한다 */
export function writeNotifyEnabled(storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined, enabled: boolean): void {
  try {
    if (enabled) storage?.setItem(NOTIFY_STORAGE_KEY, '1');
    else storage?.removeItem(NOTIFY_STORAGE_KEY);
  } catch {
    // 저장하지 못해도 화면은 그대로 둔다
  }
}

/**
 * 지금 브라우저 알림을 띄울 조건인지. 껐거나, 미지원이거나, 탭이 보이거나, 권한이 없으면 false.
 * 탭이 보이는 중이면 제목 배지로 충분하므로 띄우지 않는다.
 */
export function shouldNotify(input: { enabled: boolean; supported: boolean; visible: boolean; permission: string }): boolean {
  return input.enabled && input.supported && !input.visible && input.permission === 'granted';
}
