/**
 * 에이전트 목록이 바뀌었을 수 있다는 신호(#923). 세션 이벤트·훅·터미널 상태가 바뀌는 자리에서 부르고,
 * desk의 목록 통로(/api/agents/stream)가 듣고 목록을 다시 계산한다. 무엇이 바뀌었는지는 싣지 않는다 —
 * 받는 쪽이 목록을 다시 만들어 이전과 비교한다. 듣는 쪽이 없으면 아무 일도 하지 않는다
 */
const listeners = new Set<() => void>();

export function onAgentsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAgentsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 한 구독자가 깨져도 다른 구독자와 부른 쪽은 계속 간다
    }
  }
}

/**
 * 객체의 함수들을 감싸, 부를 때마다(끝난 뒤, 실패해도) 바뀜을 알린다. 관문 훅 처리(텔레메트리의 토큰·에이전트 내역처럼
 * 세션 이벤트 없이 바뀌는 사실이 있다)에 쓴다. 결과와 오류는 그대로 돌려준다. `skip`에 적은 이름은 감싸지 않는다
 */
export function pulseAfterCalls<T extends object>(handlers: T, skip: readonly string[] = ['toolSpecs']): T {
  const wrapped = { ...handlers } as Record<string, unknown>;
  for (const [name, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function' || skip.includes(name)) continue;
    wrapped[name] = (...args: unknown[]) => {
      let result: unknown;
      try {
        result = (handler as (...rest: unknown[]) => unknown)(...args);
      } catch (error) {
        notifyAgentsChanged();
        throw error;
      }
      if (result instanceof Promise) return result.finally(notifyAgentsChanged);
      notifyAgentsChanged();
      return result;
    };
  }
  return wrapped as unknown as T;
}
