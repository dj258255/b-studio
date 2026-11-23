/**
 * 옛 TS 사본과 견주던 시험의 기대값을 JSON으로 고정해 두고 같은 모양으로 꺼내 쓰는 시험 도우미(#1347).
 * 사본이 같은 입력에 낸 값을 `<이름>-vectors.json`에 입력(인자 JSON)별로 적어 두었고, 시험은 사본 대신 그 표를 읽는다.
 * 값은 태그를 붙여 적는다(`undefined`·NaN·±Infinity·-0·bigint·Map·Set·Date·성긴 배열, 던진 오류).
 */
export type FrozenTable = Record<string, unknown>;

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TAG = '$';
const ancestors = new Set<object>();

export function encodeValue(value: unknown, dropUndefined = false, sortKeys = false): unknown {
  if (value === undefined) return { [TAG]: 'u' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { [TAG]: 'nan' };
    if (value === Infinity) return { [TAG]: '+inf' };
    if (value === -Infinity) return { [TAG]: '-inf' };
    if (Object.is(value, -0)) return { [TAG]: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { [TAG]: 'big', v: value.toString() };
  // 함수는 입력의 키로만 쓴다(이름으로 구분). 값으로 돌려받은 함수는 고정할 수 없다
  if (typeof value === 'function') return { [TAG]: 'fn', name: value.name };
  if (typeof value === 'symbol') throw new Error('심볼은 고정할 수 없습니다');
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return { [TAG]: 'cycle' };
  ancestors.add(value);
  try {
    return encodeObjectLike(value, dropUndefined, sortKeys);
  } finally {
    ancestors.delete(value);
  }
}

function encodeObjectLike(value: object, drop: boolean, sort: boolean): unknown {
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      const entries: Array<[number, unknown]> = [];
      for (const key of Object.keys(value)) entries.push([Number(key), encodeValue(value[Number(key)], drop, sort)]);
      return { [TAG]: 'sparse', length: value.length, entries };
    }
    return value.map((inner) => encodeValue(inner, drop, sort));
  }
  if (value instanceof Map) return { [TAG]: 'map', v: [...value].map(([k, v]) => [encodeValue(k, drop, sort), encodeValue(v, drop, sort)]) };
  if (value instanceof Set) return { [TAG]: 'set', v: [...value].map((inner) => encodeValue(inner, drop, sort)) };
  if (value instanceof Date) return { [TAG]: 'date', v: value.getTime() };
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  if (sort) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, inner] of entries) {
    if (drop && inner === undefined) continue;
    out[key] = encodeValue(inner, drop, sort);
  }
  return Object.prototype.hasOwnProperty.call(out, TAG) ? { [TAG]: 'obj', v: out } : out;
}

export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const record = value as Record<string, unknown>;
  const tag = record[TAG];
  if (typeof tag === 'string') {
    switch (tag) {
      case 'u': return undefined;
      case 'nan': return Number.NaN;
      case '+inf': return Infinity;
      case '-inf': return -Infinity;
      case '-0': return -0;
      case 'big': return BigInt(record.v as string);
      case 'map': return new Map((record.v as unknown[][]).map(([k, v]) => [decodeValue(k), decodeValue(v)]));
      case 'set': return new Set((record.v as unknown[]).map(decodeValue));
      case 'date': return new Date(record.v as number);
      case 'sparse': {
        const array = new Array<unknown>(record.length as number);
        for (const [index, inner] of record.entries as Array<[number, unknown]>) array[index] = decodeValue(inner);
        return array;
      }
      case 'obj': return decodeObject(record.v as Record<string, unknown>);
      default: throw new Error(`알 수 없는 태그: ${tag}`);
    }
  }
  return decodeObject(record);
}

function decodeObject(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) out[key] = decodeValue(inner);
  return out;
}

export function keyOf(name: string, args: readonly unknown[]): string {
  const json = JSON.stringify(encodeValue([...args]));
  // 긴 입력은 해시로 줄인다(같은 입력은 같은 키, 다른 입력이 겹칠 확률은 무시할 만하다)
  return json.length <= 200 ? `${name}(${json})` : `${name}#${createHash('sha256').update(json).digest('hex').slice(0, 24)}`;
}

interface Stored {
  kind: 'value' | 'throw';
  async?: boolean;
  v?: unknown;
  name?: string;
  message?: string;
}

/** 표에 저장된 한 호출의 결과를 꺼낸다. 던진 것은 던지고, 비동기였으면 약속으로 돌려준다 */
function play(table: FrozenTable, name: string, args: readonly unknown[]): unknown {
  const key = keyOf(name, args);
  const stored = table[key] as Stored | undefined;
  if (stored === undefined) throw new Error(`고정한 기대값에 없는 호출입니다: ${key.slice(0, 300)}`);
  const run = (): unknown => {
    if (stored.kind === 'throw') {
      const error = new Error(stored.message);
      error.name = stored.name ?? 'Error';
      throw error;
    }
    return decodeValue(stored.v);
  };
  return stored.async ? Promise.resolve().then(run) : run();
}

/** 고정한 표를 사본 모듈처럼 쓰게 하는 껍데기: `frozen.someFunction(...args)` */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FrozenModule = any;

export function frozenModule(table: FrozenTable, prefix = ''): FrozenModule {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const constKey = `${prefix}${prop}#const`;
      if (constKey in table) return decodeValue((table[constKey] as Stored).v);
      return (...args: unknown[]) => play(table, `${prefix}${prop}`, args);
    },
  });
}

/** 사본을 불러 부른 입력과 낸 값을 표에 적는 껍데기(고정값을 만들 때만 쓴다) */
export function recordingModule<T extends object>(real: T, table: FrozenTable, prefix = ''): T {
  return new Proxy(real, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof prop !== 'string') return value;
      if (typeof value !== 'function') {
        table[`${prefix}${prop}#const`] = { kind: 'value', v: encodeValue(value) } satisfies Stored;
        return value;
      }
      return (...args: unknown[]) => {
        const key = keyOf(`${prefix}${prop}`, args);
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
            return (result as Promise<unknown>).then(
              (resolved) => {
                table[key] = { kind: 'value', async: true, v: encodeValue(resolved) } satisfies Stored;
                return resolved;
              },
              (error: unknown) => {
                table[key] = { kind: 'throw', async: true, name: (error as Error).name, message: (error as Error).message } satisfies Stored;
                throw error;
              },
            );
          }
          table[key] = { kind: 'value', v: encodeValue(result) } satisfies Stored;
          return result;
        } catch (error) {
          table[key] = { kind: 'throw', name: (error as Error).name, message: (error as Error).message } satisfies Stored;
          throw error;
        }
      };
    },
  });
}

/** 값 하나의 짧은 지문. 입력 조합이 많아 값을 다 적기 어려운 곳에서 쓴다 */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(encodeValue(value))).digest('hex').slice(0, 16);
}

export function loadTable(url: URL): FrozenTable {
  return JSON.parse(readFileSync(url, 'utf8')) as FrozenTable;
}

/** 이름표로 값을 적고 꺼내는 표(호출 한 번이 아니라 시험의 한 단계 결과를 고정할 때 쓴다) */
/**
 * 이름표에 넣을 시각. 절대 시각(getTime)은 시간대마다 달라(현지 시각으로 만든 Date) CI(UTC)에서 이름표를 찾지 못한다.
 * 기간 이름(periodKey)이 현지 날짜로 끊으므로 이름표도 현지 시각 글자로 적는다(예: 2026-09-12T09:00)
 */
export function localStamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function book(table: FrozenTable) {
  return {
    get(label: string): unknown {
      const key = `book:${label}`;
      if (!(key in table)) throw new Error(`고정한 기대값에 없는 이름표입니다: ${label.slice(0, 300)}`);
      return decodeValue(table[key]);
    },
    put(label: string, value: unknown): void {
      table[`book:${label}`] = encodeValue(value);
    },
  };
}

/**
 * 값을 차례로 넣어 한 줄로 요약하는 장부. 단계마다 값을 다 적기 어려운 열(수천 번의 질의)에서 옛 구현이 낸 값의 열을 지문 하나로 고정한다.
 * `undefined`인 속성은 빼고 적는다(`toEqual`과 같은 눈금). `sortKeys`를 켜면 객체의 키 순서도 보지 않는다(`toEqual`은 키 순서를 보지 않는다).
 */
export function ledger(options: { sortKeys?: boolean } = {}) {
  const hash = createHash('sha256');
  let count = 0;
  return {
    add(value: unknown): void {
      hash.update(`${JSON.stringify(encodeValue(value, true, options.sortKeys === true))}\n`);
      count += 1;
    },
    get count(): number {
      return count;
    },
    digest(): string {
      return `${count}:${hash.copy().digest('hex').slice(0, 16)}`;
    },
  };
}
