import type { ChatItem } from './session-view';
import type { SessionSnapshot } from './studio-events';

/** 한 화면에 나란히 볼 수 있는 세션 수 상한 */
export const MAX_SPLIT = 4;
/** 최근에 나란히 본 세션 id를 두는 자리. 세션 화면에서 "나란히 보기에 추가"할 때 쓴다 */
export const SPLIT_STORAGE_KEY = 'b-studio:split-ids';

/**
 * `/split?ids=a,b,c`의 ids를 정리한다. 빈 값과 중복을 빼고 상한까지만 쓴다(주소가 손으로 고쳐져도 서버가 지킨다)
 */
export function parseSplitIds(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return [];
  const ids: string[] = [];
  for (const part of value.split(',')) {
    const id = part.trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_SPLIT) break;
  }
  return ids;
}

export function splitHref(ids: readonly string[]): string {
  return ids.length > 0 ? `/split?ids=${ids.join(',')}` : '/split';
}

/** 나란히 보기에 세션을 더한다. 이미 있으면 맨 뒤로 옮기고, 상한을 넘으면 먼저 담긴 것부터 버린다 */
export function nextSplitIds(existing: readonly string[], id: string): string[] {
  return [...existing.filter((candidate) => candidate !== id), id].slice(-MAX_SPLIT);
}

/** 배치: 1개면 한 칸, 2개면 좌우(2×1), 3~4개면 2×2 */
export function splitLayout(count: number): { columns: 1 | 2; rows: 1 | 2 } {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  return { columns: 2, rows: 2 };
}

/**
 * 배치 클래스. 좁은 화면(<900px)에서는 한 열로 쌓고, `min-[900px]`부터 칸을 나눈다.
 * Tailwind가 클래스를 소스에서 찾으므로 문자열을 조립하지 않고 통째로 적는다
 */
export function splitGridClass(count: number): string {
  const { columns, rows } = splitLayout(count);
  const wide = rows === 2 ? 'min-[900px]:grid-cols-2 min-[900px]:grid-rows-2' : columns === 2 ? 'min-[900px]:grid-cols-2 min-[900px]:grid-rows-1' : 'min-[900px]:grid-cols-1';
  return `grid min-h-0 grid-cols-1 gap-3 ${wide}`;
}

/** 칸 머리에 보여 줄 상태 점·문구. 준비 중·작업 중·대기·오류·중지됨 */
export function paneState(snapshot: Pick<SessionSnapshot, 'status' | 'running'>): { tone: 'pass' | 'fail' | 'wait' | 'idle'; label: string } {
  if (snapshot.status === 'failed') return { tone: 'fail', label: '오류' };
  if (snapshot.status === 'starting') return { tone: 'wait', label: '준비 중' };
  if (snapshot.status === 'stopped') return { tone: 'idle', label: '중지됨' };
  if (snapshot.running) return { tone: 'wait', label: '작업 중' };
  return { tone: 'pass', label: '대기' };
}

/** 경과 시간을 사람이 읽는 문구로. 1시간이 넘으면 분 단위까지만 적는다 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 최근에 나란히 본 세션 id. 저장소를 못 읽어도(사생활 보호 모드 등) 빈 목록으로 동작한다 */
export function readStoredSplitIds(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    return parseSplitIds(storage?.getItem(SPLIT_STORAGE_KEY) ?? undefined);
  } catch {
    return [];
  }
}

/** 저장 실패는 무시한다. 그래도 이번 이동은 동작한다 */
export function storeSplitIds(storage: Pick<Storage, 'setItem'> | undefined, ids: readonly string[]): void {
  try {
    storage?.setItem(SPLIT_STORAGE_KEY, ids.join(','));
  } catch {
    return;
  }
}

export type SplitTone = 'pass' | 'fail' | 'wait' | 'idle';

export interface SplitLine {
  key: string;
  kind: 'request' | 'reply' | 'tool' | 'check' | 'gate' | 'outcome' | 'note';
  text: string;
  tone?: SplitTone;
}

const REQUEST_MAX = 400;
const REPLY_MAX = 600;
const SUMMARY_MAX = 200;
/** 칸에는 최근 것만 남긴다. 더 오래된 항목은 세션 화면에서 본다 */
const LINE_LIMIT = 80;

/**
 * 칸에 보여 줄 대화 요약. 세션 화면과 같은 이벤트 변환(reduceSession)의 결과를 받아 줄 단위로 줄인다.
 * 도구는 호출 한 줄만 남기고 결과 본문은 넣지 않는다(칸이 작다). 자세한 내용은 세션 화면에서 본다
 */
export function splitLines(chat: readonly ChatItem[], limit = LINE_LIMIT): SplitLine[] {
  const lines: SplitLine[] = [];
  chat.forEach((item, index) => {
    switch (item.kind) {
      case 'request':
        lines.push({ key: `r${index}`, kind: 'request', text: clip(item.text, REQUEST_MAX) });
        break;
      case 'reply':
        lines.push({ key: `a${index}`, kind: 'reply', text: clip(item.text, REPLY_MAX) });
        break;
      case 'tools':
        item.calls.forEach((call, callIndex) => {
          const tone: SplitTone = call.ok === false ? 'fail' : call.ok === true ? 'pass' : call.interrupted ? 'idle' : 'wait';
          const status = call.ok === false ? '실패' : call.ok === true ? '완료' : call.interrupted ? '중단' : '실행 중';
          lines.push({ key: `t${index}-${callIndex}`, kind: 'tool', text: `${status} ${clip(call.summary, 120)}`, tone });
        });
        break;
      case 'check':
        lines.push({ key: `c${index}`, kind: 'check', text: `${item.name} · ${item.ok ? '통과' : '실패'}`, tone: item.ok ? 'pass' : 'fail' });
        break;
      case 'gate':
        lines.push({
          key: `g${index}`,
          kind: 'gate',
          text: item.report ? (item.report.ok ? '검증 게이트 통과' : '검증 게이트 실패') : item.interrupted ? '검증 게이트 중단' : '검증 게이트 확인 중',
          tone: item.report ? (item.report.ok ? 'pass' : 'fail') : item.interrupted ? 'idle' : 'wait',
        });
        break;
      case 'outcome':
        lines.push({
          key: `o${index}`,
          kind: 'outcome',
          text: `${item.status === 'done' ? (item.intent === 'ask' ? '답변 완료' : '완료') : item.status === 'failed' ? '완료하지 못함' : '취소됨'} · ${clip(item.summary, SUMMARY_MAX)}`,
          tone: item.status === 'done' ? 'pass' : item.status === 'cancelled' ? 'idle' : 'fail',
        });
        break;
      case 'checkpoint':
        lines.push({ key: `k${index}`, kind: 'note', text: `체크포인트 ${item.checkpoint.shortSha} · 파일 ${item.checkpoint.files.length}개`, tone: 'idle' });
        break;
      case 'reverted':
        lines.push({ key: `v${index}`, kind: 'note', text: `${item.cancelled ? '취소해' : '검증을 통과하지 못해'} 바뀐 파일 ${item.files.length}개를 되돌렸습니다`, tone: 'fail' });
        break;
      case 'resumed':
        lines.push({ key: `u${index}`, kind: 'note', text: '새 샌드박스에서 이어서 작업합니다', tone: 'idle' });
        break;
      case 'localEdits':
        lines.push({ key: `l${index}`, kind: 'note', text: `폴더에서 바뀐 파일 ${item.checkpoint.files.length}개를 체크포인트로 남겼습니다`, tone: 'idle' });
        break;
      default:
        // route·backend·stage·restore·remoteSync·deploy·exported는 칸에서 줄이지 않는다(세션 화면에서 본다)
        break;
    }
  });
  return lines.slice(-limit);
}
