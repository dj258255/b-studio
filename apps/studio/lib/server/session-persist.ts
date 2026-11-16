import { native, type NativePersister, type NativePersistState } from '@b-studio/sandbox';
import type { SessionRecord } from './session-record';

/**
 * 세션 하나의 저장(ADR-203, 4f B1b): 500ms 모으기와 쓰기를 차례로 잇는 줄. Rust(`crates/bstudio-session`의 `Persister`)가 쥐고 이 클래스는 콜백만 맡는다.
 * 옛 `sessions.ts`의 `persist: { timer, chain }`과 `schedulePersist`·`flushPersist`를 대신한다.
 *
 * - `state`는 **쓰기를 시작할 때** 메인 스레드에서 불린다(앞의 쓰기가 끝난 뒤). `{ file, head, tail }`을 돌려주면 Rust가 같은 순간에 기록의 저장용 history를 `head`와 `tail` 사이에 끼워
 *   옛 `JSON.stringify(toPersisted(session))`와 바이트까지 같은 글자를 쓴다. 던지면 그 쓰기는 하지 않고 이유를 알린다
 * - 쓰기가 실패해도 세션은 계속한다. 이유는 `console.error`로 찍는다(`flush()`는 던지지 않는다)
 * - 이 객체는 Node 프로세스를 붙잡지 않는다(타이머도 콜백도 약한 참조다. 옛 `unref`와 같다)
 */
export class SessionPersist {
  private readonly inner: NativePersister;
  private readonly onError: (message: string) => void;

  constructor(record: SessionRecord, state: () => NativePersistState, options: { onError?: (message: string) => void; delayMs?: number } = {}) {
    this.onError = options.onError ?? defaultOnError;
    this.inner = new native.Persister(
      record.native,
      () => {
        // 던지지 않고 이유로 돌려준다: 콜백이 던지면 Node가 "잡지 못한 N-API 예외"로 경고한다
        try {
          return state();
        } catch (error) {
          return { file: '', head: '', tail: '', error: error instanceof Error ? error.message : String(error) };
        }
      },
      this.onError,
      options.delayMs,
    );
  }

  /** 저장을 예약한다. 이미 예약돼 있으면 아무것도 하지 않는다 */
  schedule(): void {
    this.inner.schedule();
  }

  /** 예약을 지운다(쓰지 않는다). 줄에 선 쓰기는 그대로다 */
  cancel(): void {
    this.inner.cancel();
  }

  /** 예약을 지우고 쓰기를 줄에 잇는다. 약속은 이번 쓰기가 끝날 때 풀린다. 던지지 않는다 */
  async flush(): Promise<void> {
    const failure = await this.inner.flush();
    if (failure) this.onError(failure);
  }

  /** 지금까지 줄에 선 쓰기가 모두 끝나면 풀린다 */
  idle(): Promise<void> {
    return this.inner.idle();
  }

  /** 종료 신호 처리용: 이 스레드에서 동기로 쓴다. 던질 수 있다 */
  flushSync(parts: NativePersistState): void {
    this.inner.flushSync(parts.file, parts.head, parts.tail);
  }
}

const defaultOnError = (message: string): void => console.error('[b-studio] 세션 상태를 저장하지 못했습니다', message);
