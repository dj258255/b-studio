import { decodeNative, native, type NativeSessionRecord } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';

/**
 * 세션 하나의 이벤트 기록(history·logs)과 그 질의(ADR-203, 4f B1a). 기록은 Rust(`crates/bstudio-session`)가 쥐고 이 클래스는 JSON 경계만 맡는다.
 * 구독자 전달·SSE·저장 예약은 여기에 없다(`sessions.ts`의 세션이 쥔다). 옛 구현은 `session-record-legacy.ts`에 차등 시험의 기준으로 남아 있다.
 *
 * 경계: 이벤트는 `JSON.stringify`한 글자로 넘긴다. `JSON.stringify`는 짝 없는 서로게이트를 `\ud800` 이스케이프로 쓰므로 Rust가 글자 그대로 들고 있다가 돌려주면 `JSON.parse`가 원래 글자로 되돌린다.
 * 유한하지 않은 수와 -0은 JSON으로 쓸 수 없어 한 키짜리 표시 객체로 보내고 되받을 때(`decodeNative`) 되돌린다.
 */

const NONFINITE_KEY = '\u0000nf';

/** `encodeNative`와 같되, 표시 객체와 같은 키(`\0nf`)만 던진다. NUL로 시작하는 다른 키는 모델이 도구 인자로 보낼 수 있어 받는다(Rust는 그 키를 받는 읽기를 쓴다) */
export function encodeEvent(event: StudioEvent): string {
  return JSON.stringify(event, (_key, item: unknown) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return { [NONFINITE_KEY]: Object.is(item, -0) ? '-0' : String(item) };
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.hasOwn(item, NONFINITE_KEY)) {
      throw new Error('표시 객체와 같은 키(NUL + nf)는 세션 기록에 쌓을 수 없습니다');
    }
    return item;
  });
}

/**
 * Rust가 준 JSON 배열 글자를 이벤트로 푼다. 표시 객체(유한하지 않은 수)가 있을 때만 reviver를 쓴다: reviver는 모든 값에 불려 `JSON.parse`를 몇 배 느리게 하는데,
 * 표시 객체는 `\u0000nf`(NUL + nf 키의 이스케이프)로만 글자에 나타난다
 */
const decodeEvents = (text: string): StudioEvent[] => (text.includes('\\u0000nf') ? decodeNative<StudioEvent[]>(text) : (JSON.parse(text) as StudioEvent[]));

export class SessionRecord {
  private readonly inner: NativeSessionRecord;

  /** `logs`가 거짓이면 보관 세션의 기록이다(logs 없음, 되감기도 로그를 보내지 않는다) */
  constructor(options: { logs: boolean; history?: readonly StudioEvent[] }) {
    this.inner = new native.SessionRecord(options.logs);
    if (options.history) this.replaceHistory(options.history);
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
