/**
 * 조율 게시판의 메모 종류와 상한.
 *
 * 원칙(이 폴더 전체에 적용한다):
 *  - 기본값은 공유 없음(지금 동작). 조율은 켰을 때만 켜진다
 *  - 효과는 벤치로 잰 뒤에만 주장한다. 이 묶음은 메커니즘만 만든다
 *  - failure 메모는 플랫폼(검증기)만 쓴다. 모델의 추측은 실패로 넘기지 않는다
 *  - 조율 모듈은 Git·샌드박스·작업 공간을 모른다(coordination/boundary.test.ts가 강제)
 */

export type NoteKind = 'contract' | 'failure' | 'fact';

export interface Note {
  id: string;
  kind: NoteKind;
  body: string;
  refs: string[];
  author: { lane: string; task?: string; by: 'model' | 'platform' };
  group?: string;
  priority: number;
  at: string;
}

export interface BoardLimits {
  /** 메모 하나의 최대 바이트(UTF-8) */
  noteBytes: number;
  /** 레인당 쓸 수 있는 메모 수 */
  writesPerLane: number;
  /** 한 번에 읽을 수 있는 메모 수 */
  readLimit: number;
  /** 레인별 누적 읽은 바이트 상한 */
  readBytesPerLane: number;
}

export const DEFAULT_BOARD_LIMITS: BoardLimits = {
  noteBytes: 2048,
  writesPerLane: 8,
  readLimit: 20,
  readBytesPerLane: 32768,
};

/** 실패 > 계약 > 사실. 읽기 정렬과 잘림 판단에 쓴다 */
export const NOTE_PRIORITY: Record<NoteKind, number> = { failure: 3, contract: 2, fact: 1 };

/** 본문 크기는 사람이 읽는 글자 수가 아니라 전송 바이트로 잰다(멀티바이트 문자 포함) */
export function noteBytes(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}
