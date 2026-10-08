/**
 * 누가 누구의 메모를 읽을 수 있는가(topology).
 *
 * star는 레인끼리 직접 보지 못하게 하고(허브·자기 것·플랫폼만), hierarchical은 같은 그룹까지,
 * mesh는 모든 레인을 연다. 검증기(플랫폼)가 쓴 메모는 어느 topology에서도 읽힌다 —
 * 실패 서명은 모든 레인에 공통인 사실이기 때문이다.
 */
import type { Note } from './notes';

export type Topology = 'star' | 'hierarchical' | 'mesh';

export interface Reader {
  lane: string;
  group?: string;
}

export function canRead(topology: Topology, reader: Reader, note: Note, hub: string): boolean {
  // 조정자(허브)는 중계(S7)를 위해 모든 메모를 읽는다. 화면용 canLaneRead에는 허브 독자가 없어 규칙이 갈리지 않는다
  if (reader.lane === hub) return true;
  // 플랫폼(검증기)이 쓴 메모는 topology와 무관하게 모든 레인이 읽는다
  if (note.author.by === 'platform') return true;
  // 자기 메모는 항상 읽는다
  if (note.author.lane === reader.lane) return true;
  if (topology === 'mesh') return true;
  // 허브(계획·통합)가 쓴 메모는 star·hierarchical 모두에서 읽는다
  if (note.author.lane === hub) return true;
  if (topology === 'hierarchical') return reader.group !== undefined && note.group === reader.group;
  // star: 레인끼리 직접 보지 않는다
  return false;
}
