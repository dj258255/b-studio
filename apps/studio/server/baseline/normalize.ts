import type { World } from './harness';

/**
 * 기준 사진에서 실행마다 달라지는 값만 자리표시자로 바꾼다: 시각, id, 포트, pid, 임시 경로, 시간(ms) 필드.
 * 의미가 있는 값(상태, 글, 개수, 파일 이름)은 건드리지 않는다. git 커밋 id는 처음 본 순서대로 번호를 매겨 "같은 커밋인지"는 남긴다
 */
export interface Normalizer {
  text: (value: string) => string;
  value: (value: unknown) => unknown;
  learnShas: (shas: string[]) => void;
  /** 실행 id는 값이 나올 때 번호를 매기므로, 경로 같은 글을 바꾸기 전에 이벤트·본문을 먼저 훑는다 */
  learnRuns: (value: unknown) => void;
}

/** 값이 실행마다 다르거나 시간 측정인 키 */
const VOLATILE_KEYS = new Set([
  'durationMs',
  'elapsedMs',
  'gateMs',
  'toolMs',
  'latencyMs',
  'startedAt',
  'updatedAt',
  'createdAt',
  'at',
  'pid',
  'port',
  'previewToken',
  'token',
  'savedAt',
]);

export function normalizer(world: World, sessionId: string): Normalizer {
  const shas = new Map<string, number>();
  const uuids = new Map<string, number>();
  const runs = new Map<string, number>();
  const containers = new Map<string, number>();
  const ordinal = (map: Map<string, number>, key: string) => {
    if (!map.has(key)) map.set(key, map.size + 1);
    return map.get(key)!;
  };
  // 짧은 커밋 id(7자)는 긴 id를 본 뒤에만 알아본다. 모르는 7자 글은 건드리지 않는다
  const short = (word: string): string => {
    for (const [sha, n] of shas) if (sha.startsWith(word)) return `<sha:${n}>`;
    return word;
  };
  const text = (input: string): string =>
    [...runs].reduce((acc, [id, n]) => acc.replaceAll(id, `<run:${n}>`), input)
      .replaceAll(world.root, '<root>')
      .replaceAll(sessionId, '<sid>')
      .replace(/studio-demo-[0-9a-f]{6}/g, '<sandbox>')
      .replace(/\b[0-9a-f]{40}\b/g, (sha) => `<sha:${ordinal(shas, sha)}>`)
      .replace(/\b[0-9a-f]{64}\b/g, (id) => `<container:${ordinal(containers, id)}>`)
      .replace(/\b[0-9a-f]{7}\b/g, short)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (id) => `<uuid:${ordinal(uuids, id)}>`)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
      // 잰 시간(소수 초): "반영 확인: 0.1초"
      .replace(/\d+\.\d초/g, '<n>초')
      // 시각으로 만든 id(되돌릴 때 남기는 보관본 이름: 2026-11-11T11-04-01-070Z-0001)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, '<time>')
      .replace(/(127\.0\.0\.1|localhost|0\.0\.0\.0):\d{2,5}/g, '$1:<port>');
  const value = (input: unknown, key?: string): unknown => {
    if (key !== undefined && VOLATILE_KEYS.has(key) && (typeof input === 'string' || typeof input === 'number')) return `<${key}>`;
    if (key === 'runId' && typeof input === 'string') return `<run:${ordinal(runs, input)}>`;
    if (typeof input === 'string') return text(input);
    if (Array.isArray(input)) return input.map((item) => value(item));
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, v]) => [text(k), value(v, k)]));
    return input;
  };
  const learnRuns = (input: unknown): void => {
    if (Array.isArray(input)) input.forEach(learnRuns);
    else if (input !== null && typeof input === 'object') {
      for (const [k, v] of Object.entries(input)) {
        if (k === 'runId' && typeof v === 'string') ordinal(runs, v);
        else learnRuns(v);
      }
    }
  };
  return { learnRuns, text, value: (input) => value(input), learnShas: (list) => list.forEach((sha) => ordinal(shas, sha)) };
}
