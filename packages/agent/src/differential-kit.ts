import { isDeepStrictEqual } from 'node:util';

/**
 * 옛 TS 구현과 Rust 껍데기를 같은 무작위 입력으로 견주는 차등 시험의 공용 도구(ADR-191). 테스트 파일(`*-differential.test.ts`)만 쓴다.
 * 입력은 시드를 고정한 mulberry32로 만든다(같은 시드는 언제나 같은 입력).
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Gen {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** 0 이상 n 미만의 정수 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  /** 가중치 목록에서 하나 */
  weighted<T>(items: ReadonlyArray<readonly [number, T]>): T {
    const total = items.reduce((sum, [weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [weight, item] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1]![1];
  }
  /** 길이가 min 이상 max 이하인 목록 */
  list<T>(min: number, max: number, make: () => T): T[] {
    const count = min + this.int(max - min + 1);
    return Array.from({ length: count }, make);
  }
  /** 알파벳에서 len개 */
  text(alphabet: readonly string[], len: number): string {
    let out = '';
    for (let i = 0; i < len; i++) out += this.pick(alphabet);
    return out;
  }
}

export type Outcome = { threw: true } | { threw: false; value: unknown };

export function outcome(fn: () => unknown): Outcome {
  try {
    return { threw: false, value: fn() };
  } catch {
    return { threw: true };
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function replaceLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE, '\ufffd');
}

/** 짝 없는 서로게이트를 U+FFFD로 바꾼 값. Rust는 짝 없는 서로게이트를 담지 못해 경계에서 U+FFFD가 된다(의도한 차이) */
export function wellFormed<T>(value: T): T {
  if (typeof value === 'string') return replaceLoneSurrogates(value) as T;
  if (Array.isArray(value)) return value.map((item) => wellFormed(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [replaceLoneSurrogates(key), wellFormed(item)])) as T;
  }
  return value;
}

/** JSON.stringify 글자(키 순서 포함)와 값(-0·NaN 구별)이 모두 같아야 같다 */
export function sameOutcome(legacy: Outcome, current: Outcome): boolean {
  if (legacy.threw || current.threw) return legacy.threw === current.threw;
  // 껍데기가 입력 객체를 그대로 돌려주는 함수(attachResults)는 짝 없는 서로게이트가 남으므로 양쪽 모두 같은 규칙으로 맞춘다
  const expected = wellFormed(legacy.value);
  const actual = wellFormed(current.value);
  return JSON.stringify(expected) === JSON.stringify(actual) && isDeepStrictEqual(expected, actual);
}

/** 결과를 조금만 바꾼 "새 결과". 차이를 잡는 장치가 작동하는지 확인하는 데 쓴다 */
export function perturb(value: unknown): unknown {
  if (typeof value === 'string') return `${value}\u0001`;
  if (typeof value === 'number') return Number.isFinite(value) && value + 1 !== value ? value + 1 : 0;
  if (typeof value === 'boolean') return !value;
  if (Array.isArray(value)) return value.length === 0 ? [null] : [...value.slice(0, -1), perturb(value[value.length - 1])];
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return { x: 1 };
    const last = entries[entries.length - 1]!;
    return Object.fromEntries([...entries.slice(0, -1), [last[0], perturb(last[1])]]);
  }
  return 1;
}

export function readEnvList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  return raw ? raw.split(',').map((item) => Number(item.trim())) : fallback;
}

export function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? Number(raw) : fallback;
}
