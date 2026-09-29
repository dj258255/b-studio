import type { Steering } from '@b-studio/agent';

/**
 * 실행 중 지시 큐. 사람이 보는 단일 세션의 실행마다 하나씩 만들고,
 * 러너가 다음 모델 호출(또는 다음 턴, 입력 큐) 때 꺼내 간다.
 * 메모리에만 두므로 서버가 다시 시작되면 사라진다(진행 중이던 실행도 함께 끝난다).
 */
export class SteeringQueue implements Steering {
  #items: string[] = [];
  #listeners = new Set<() => void>();

  /** 지시를 큐에 넣고 기다리는 러너에게 알린다 */
  push(text: string): void {
    this.#items.push(text);
    for (const listener of this.#listeners) listener();
  }

  /** 쌓인 지시를 꺼내 비운다. 꺼낸 지시는 러너가 대화에 넣는다 */
  take(): string[] {
    return this.#items.splice(0);
  }

  /** 지시가 들어오면 부른다. 로컬 Claude 러너가 입력 큐에 대기 없이 넣는 데 쓴다 */
  onPush(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
