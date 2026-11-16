import { native, type NativeSessionRecord } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';

/**
 * 세션 하나의 이벤트 기록(history·logs)과 그 질의(ADR-203, 4f B1a). 기록은 Rust(`crates/bstudio-session`)가 쥐고 이 클래스는 JSON 경계만 맡는다.
 * 구독자 전달·SSE·저장 예약은 여기에 없다(`sessions.ts`의 세션이 쥔다). 옛 구현은 `session-record-legacy.ts`에 차등 시험의 기준으로 남아 있다.
 *
 * 경계: 이벤트는 `JSON.stringify`한 글자로 넘긴다. `JSON.stringify`는 짝 없는 서로게이트를 `\ud800` 이스케이프로 쓰므로 Rust가 글자 그대로 들고 있다가 돌려주면 `JSON.parse`가 원래 글자로 되돌린다.
 * 유한하지 않은 수와 -0, NUL로 시작하는 키는 `encodeEvent`가 바꿔 쓰고 되받을 때 되돌린다.
 */

const NONFINITE_KEY = '\u0000nf';
const NUL = '\u0000';

/** NUL로 시작하는 키가 하나라도 있으면 그 키들 앞에 NUL을 하나 더 붙인 새 객체(순서 그대로). 없으면 그대로 */
function escapeNulKeys(item: object): object {
  const entries = Object.entries(item);
  if (!entries.some(([key]) => key.startsWith(NUL))) return item;
  // Object.fromEntries는 `__proto__`도 자기 속성으로 만든다(대입하면 원형이 바뀐다)
  return Object.fromEntries(entries.map(([key, value]) => [key.startsWith(NUL) ? NUL + key : key, value]));
}

/**
 * `JSON.stringify`하되 두 가지만 바꾼다. 어떤 이벤트도 던지지 않는다(던지면 그 이벤트가 기록에서 빠지고, 저장한 기록이면 복구가 멈춘다).
 * - 유한하지 않은 수와 -0은 JSON으로 쓸 수 없어 한 키짜리 표시 객체(`{"\0nf": "NaN"}`)로 쓴다
 * - NUL로 시작하는 키에는 NUL을 하나 더 붙인다. 그래서 표시 객체의 키는 이 표시에만 쓰이고, 모델이 도구 인자로 보낸 같은 이름의 키와 섞이지 않는다
 *
 * 둘 다 없는 이벤트는 `JSON.stringify(event)`와 글자까지 같다
 */
export function encodeEvent(event: StudioEvent): string {
  return JSON.stringify(event, (_key, item: unknown) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return { [NONFINITE_KEY]: Object.is(item, -0) ? '-0' : String(item) };
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) return escapeNulKeys(item);
    return item;
  });
}

/** `encodeEvent`를 되돌린다: 표시 객체는 수로, NUL로 시작하는 키는 앞의 NUL 하나를 뗀다 */
function revive(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === NONFINITE_KEY) {
    const mark = (value as Record<string, unknown>)[NONFINITE_KEY];
    if (mark === '-0') return -0;
    if (mark === 'NaN' || mark === 'Infinity' || mark === '-Infinity') return Number(mark);
  }
  if (!keys.some((key) => key.startsWith(NUL))) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.startsWith(NUL) ? key.slice(1) : key, item]));
}

/**
 * Rust가 준 JSON 배열 글자를 이벤트로 푼다. NUL이 든 글자(`\u0000`, 표시 객체의 키나 NUL로 시작하는 키)가 있을 때만 reviver를 쓴다:
 * reviver는 모든 값에 불려 `JSON.parse`를 몇 배 느리게 한다
 */
const decodeEvents = (text: string): StudioEvent[] => (text.includes('\\u0000') ? (JSON.parse(text, revive) as StudioEvent[]) : (JSON.parse(text) as StudioEvent[]));

export class SessionRecord {
  private readonly inner: NativeSessionRecord;

  /**
   * `logs`가 거짓이면 보관 세션의 기록이다(logs 없음, 되감기도 로그를 보내지 않는다).
   * `native`는 이미 만들어진 Rust 기록을 감싼다(`readStoredSessions`가 파일에서 올린 기록)
   */
  constructor(options: { logs: boolean; history?: readonly StudioEvent[] } | { native: NativeSessionRecord }) {
    if ('native' in options) {
      this.inner = options.native;
      return;
    }
    this.inner = new native.SessionRecord(options.logs);
    if (options.history) this.replaceHistory(options.history);
  }

  /** 같은 세션의 `Persister`가 저장할 때 읽는 Rust 기록(ADR-203, B1b) */
  get native(): NativeSessionRecord {
    return this.inner;
  }

  /**
   * 서버가 멈춰 끝나지 못한 요청·되돌리기·원격 동기화·배포를 닫는 이벤트를 history 끝에 덧붙인다(상한 없이). 덧붙인 개수.
   * 이벤트를 읽지 못하면(JSON이 아니거나 `null`이거나 필드가 너무 깊다) 던지고 아무것도 덧붙이지 않는다. 옛 `closeUnfinished`(`session-store-legacy.ts`)와 같은 결과다
   */
  closeUnfinished(reason: string): number {
    return this.inner.closeUnfinished(reason);
  }

  /**
   * `emit`의 버퍼 처리: 기록하지 않는 이벤트는 쌓지 않고, `log`는 logs에(상한 1,000), 나머지는 history에(상한 5,000) 쌓는다.
   * 돌려주는 값은 "`updatedAt`을 바꾸고 저장을 예약할 것인가"(쌓았고 `log`가 아니다)
   */
  push(event: StudioEvent): boolean {
    return this.inner.push(encodeEvent(event));
  }

  /** 상한을 적용하지 않고 history 끝에 덧붙인다(이어받기에서 저장한 기록 뒤에 붙이는 이벤트) */
  append(event: StudioEvent): void {
    this.inner.append(encodeEvent(event));
  }

  /** history를 통째로 바꾼다(이어받기·복구에서 저장한 기록을 올린다). 상한도 걸러 내기도 하지 않는다 */
  replaceHistory(events: readonly StudioEvent[]): void {
    this.inner.replaceHistory(events.map(encodeEvent));
  }

  hasLogs(): boolean {
    return this.inner.hasLogs();
  }

  /** 마지막으로 시작한 요청 글. 옛 `findLast(run_started)?.request`와 같다: Rust가 마지막 `run_started` 이벤트를 찾고 `request`는 여기서 읽는다 */
  lastRequest(): string | undefined {
    const text = this.inner.lastRunStarted();
    if (text === null || text === undefined) return undefined;
    const started = decodeEvents(`[${text}]`)[0]!;
    return started.type === 'run_started' ? started.request : undefined;
  }

  /** 끝 n개(관제 화면의 최근 이벤트) */
  tail(n: number): StudioEvent[] {
    return decodeEvents(this.inner.tail(n));
  }

  /** 전체 history(되감기, `sessionHistory`) */
  history(): StudioEvent[] {
    return decodeEvents(this.inner.history());
  }

  /** 전체 logs(되감기, 로그 따라가기의 `skipAlreadySeen` 입력). 보관 세션이면 빈 목록 */
  logs(): StudioEvent[] {
    return decodeEvents(this.inner.logs());
  }

  /** 저장할 history(`trimHistory`와 같다) */
  trimmedHistory(): StudioEvent[] {
    return decodeEvents(this.inner.trimmedHistory());
  }
}
