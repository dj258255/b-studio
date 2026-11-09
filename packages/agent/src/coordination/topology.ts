/**
 * 누가 누구의 메모를 읽을 수 있는가(topology).
 *
 * star는 레인끼리 직접 보지 못하게 하고(허브·자기 것·플랫폼만), hierarchical은 같은 그룹까지,
 * mesh는 모든 레인을 연다. 검증기(플랫폼)가 쓴 메모는 어느 topology에서도 읽힌다 —
 * 실패 서명은 모든 레인에 공통인 사실이기 때문이다.
 */
import { native } from '@b-studio/sandbox';
import type { Note } from './notes';

export type Topology = 'star' | 'hierarchical' | 'mesh';

export interface Reader {
  lane: string;
  group?: string;
}

export function canRead(topology: Topology, reader: Reader, note: Note, hub: string): boolean {
  // 판정은 Rust(crates/bstudio-guard/src/coordination.rs, ADR-191 3단계)가 한다
  return native.coordCanRead(topology, reader.lane, reader.group, note.author.by, note.author.lane, note.group, hub);
}
