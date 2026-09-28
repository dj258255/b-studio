/**
 * 계획 단위 조율 게시판(순수 메모리 구조).
 *
 * 전송은 새로 만들지 않는다. 규칙만 강제한다: 종류는 셋, 크기·쓰기 수·읽기 예산 상한,
 * 실패 메모는 검증기만, 계약은 산출물 참조 필수, 받는 쪽은 필요할 때 읽는다(pull).
 * 저장은 하지 않는다. 상태가 바뀌면 onChange(snapshot)으로 호출자에게 넘겨 호출자가 남긴다.
 */
import { DEFAULT_BOARD_LIMITS, NOTE_PRIORITY, noteBytes, type BoardLimits, type Note, type NoteKind } from './notes';
import { canRead, type Reader, type Topology } from './topology';

export interface PostInput {
  kind: NoteKind;
  body: string;
  refs?: string[];
  group?: string;
  priority?: number;
}

/** 누가 쓰는가. 작성자의 신원은 실행기(레인 신원)가 정하고 모델이 바꿀 수 없다 */
export interface Author {
  lane: string;
  task?: string;
  by: 'model' | 'platform';
}

export type PostResult = { ok: true; note: Note } | { ok: false; reason: string };

export interface ReadOptions {
  kinds?: readonly NoteKind[];
  /** 이 시각(ISO)보다 나중에 쓴 메모만 */
  since?: string;
}

export interface ReadResult {
  notes: Note[];
  truncated: boolean;
  /** 잘렸을 때 이유 */
  reason?: string;
}

export interface BoardStats {
  /** 새로 만들어진 메모 수(같은 (kind, body) 중복은 세지 않는다) */
  posts: number;
  rejected: number;
  reads: number;
  bytesRead: number;
  byKind: Record<NoteKind, number>;
}

export interface BoardOptions {
  topology: Topology;
  limits?: Partial<BoardLimits>;
  /** star·hierarchical에서 허브로 볼 레인 이름. 기본 'hub' */
  hub?: string;
  now?: () => Date;
  /** 메모가 추가될 때마다 호출자가 저장하도록 넘긴다 */
  onChange?: (snapshot: Note[]) => void;
}

export class Board {
  private readonly topology: Topology;
  private readonly limits: BoardLimits;
  private readonly hub: string;
  private readonly now: () => Date;
  private readonly onChange: ((snapshot: Note[]) => void) | undefined;
  private readonly notes: Note[] = [];
  private readonly readsByLane = new Map<string, number>();
  private readonly counters: BoardStats = { posts: 0, rejected: 0, reads: 0, bytesRead: 0, byKind: { contract: 0, failure: 0, fact: 0 } };
  private counter = 0;

  constructor(options: BoardOptions) {
    this.topology = options.topology;
    this.limits = { ...DEFAULT_BOARD_LIMITS, ...options.limits };
    this.hub = options.hub ?? 'hub';
    this.now = options.now ?? (() => new Date());
    this.onChange = options.onChange;
  }

  post(input: PostInput, as: Author): PostResult {
    const invalid = this.validate(input, as);
    if (invalid) {
      this.counters.rejected += 1;
      return { ok: false, reason: invalid };
    }
    // 같은 (kind, body)는 중복 전달이다. 새로 만들지 않고 기존 id를 그대로 돌려준다
    const existing = this.notes.find((note) => note.kind === input.kind && note.body === input.body);
    if (existing) return { ok: true, note: existing };
    const writes = this.notes.filter((note) => note.author.lane === as.lane).length;
    if (writes >= this.limits.writesPerLane) {
      this.counters.rejected += 1;
      return { ok: false, reason: `레인 쓰기 한도(${this.limits.writesPerLane}개)를 넘었습니다` };
    }
    const note: Note = {
      id: `note-${(this.counter += 1)}`,
      kind: input.kind,
      body: input.body,
      refs: input.refs ? [...input.refs] : [],
      author: { lane: as.lane, ...(as.task !== undefined ? { task: as.task } : {}), by: as.by },
      ...(input.group !== undefined ? { group: input.group } : {}),
      priority: input.priority ?? NOTE_PRIORITY[input.kind],
      at: this.now().toISOString(),
    };
    this.notes.push(note);
    this.counters.posts += 1;
    this.counters.byKind[input.kind] += 1;
    this.onChange?.(this.snapshot());
    return { ok: true, note };
  }

  read(reader: Reader, options: ReadOptions = {}): ReadResult {
    this.counters.reads += 1;
    const used = this.readsByLane.get(reader.lane) ?? 0;
    // 이미 예산을 다 쓴 레인은 그 뒤로 빈 목록만 받는다
    if (used >= this.limits.readBytesPerLane) {
      return { notes: [], truncated: true, reason: `레인 읽기 예산(${this.limits.readBytesPerLane}바이트)을 초과했습니다` };
    }
    const visible = this.notes
      .filter((note) => canRead(this.topology, reader, note, this.hub))
      .filter((note) => !options.kinds || options.kinds.includes(note.kind))
      .filter((note) => options.since === undefined || note.at > options.since)
      .sort(compareNotes);

    const budget = this.limits.readBytesPerLane - used;
    const selected: Note[] = [];
    let bytes = 0;
    let truncated = visible.length > this.limits.readLimit;
    for (const note of visible) {
      if (selected.length >= this.limits.readLimit) {
        truncated = true;
        break;
      }
      const size = noteBytes(note.body);
      if (bytes + size > budget) {
        truncated = true;
        break;
      }
      selected.push(note);
      bytes += size;
    }
    this.readsByLane.set(reader.lane, used + bytes);
    this.counters.bytesRead += bytes;
    return truncated ? { notes: selected, truncated: true, reason: '읽기 예산 또는 개수 상한으로 일부만 돌려줬습니다' } : { notes: selected, truncated: false };
  }

  snapshot(): Note[] {
    return this.notes.map((note) => ({ ...note, refs: [...note.refs], author: { ...note.author } }));
  }

  stats(): BoardStats {
    return { ...this.counters, byKind: { ...this.counters.byKind } };
  }

  private validate(input: PostInput, as: Author): string | undefined {
    if (input.kind === 'failure' && as.by === 'model') return '실패 메모는 검증기만 씁니다';
    if (input.body.trim().length === 0) return '빈 메모는 쓸 수 없습니다';
    if (noteBytes(input.body) > this.limits.noteBytes) return `메모가 너무 큽니다(최대 ${this.limits.noteBytes}바이트)`;
    if (input.kind === 'contract' && (input.refs ?? []).length === 0) return '계약 메모는 refs가 하나 이상 필요합니다';
    return undefined;
  }
}

/** 우선순위 내림차순 → 최신순. 같은 시각이면 id로 안정 정렬한다 */
function compareNotes(a: Note, b: Note): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
