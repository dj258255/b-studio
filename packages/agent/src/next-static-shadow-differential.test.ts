import { describe, expect, it } from 'vitest';
import { findStaticShadows as findNew, type StaticShadowInput } from './next-static-shadow';
import { findStaticShadows as findLegacy } from './next-static-shadow-legacy';
import { Gen } from './differential-kit';
import { buildProject } from './next-static-shadow-testkit';

/**
 * 고정 경로 판정(ADR-191 3aa)의 차등 시험. 같은 임시 프로젝트와 같은 질문을 옛 TS(`next-static-shadow-legacy.ts`)와 새 껍데기에 넣어 견준다.
 * 결과는 JSON 글자로 견주고, 던짐은 메시지까지 견준다. 입력을 둘로 가른다:
 *  - 보통 이름(ASCII·인코딩·그룹·슬롯·링크): 옛 것과 **글자까지 같아야** 한다.
 *  - 넓힌 이름(끝 공백, 보이지 않는 글자, 호환 문자, 정규화 형태, 줄 끝 글자가 든 그룹, `()`, 짝 없는 서로게이트): 더 막는 쪽으로만 달라질 수 있다.
 *    "거부한 이름 집합"(던지면 확인 대상 전부, 아니면 겹친 이름)으로 견줘, 옛 구현이 거부한 이름을 새 구현이 거부하지 않은 수(열린 쪽 뒤집힘)가 0이어야 한다.
 *
 * 대조 장치: 옛 구현에 입력을 바꿔 넣어(상한 +1, 값 뒤에 글자 덧붙임, 확인 이름 하나 빼기) 새 구현과 견주면 차이로 잡혀야 한다.
 * 크기는 환경 변수로 바꾼다: STATIC_SHADOW_DIFF_SEEDS(쉼표 목록), STATIC_SHADOW_DIFF_PROJECTS(시드마다 프로젝트 수), STATIC_SHADOW_DIFF_REPORT=1(분포 출력)
 */
const SEEDS = (process.env['STATIC_SHADOW_DIFF_SEEDS'] ?? '1,7,42').split(',').map(Number);
const PROJECTS = Number(process.env['STATIC_SHADOW_DIFF_PROJECTS'] ?? 25);
const QUERIES = 8;
const REPORT = process.env['STATIC_SHADOW_DIFF_REPORT'] === '1';

const PLAIN_NAMES = ['new', 'New', 'NEW', 'n', 'ne', 'new.tsx', 'new.page.tsx', '%6Eew', '%5Fnew', '_new', 'list', '[id]', '[slug]', '(g)', '(h)', '@m', '(.)new', '(..)x', '(..)(..)new', 'icon.png', '[...a]', '70', 'orders', 'Orders', 'shops', 'main', '%', '%zz', 'new.'];
const WIDE_NAMES = ['new ', 'new​', 'ｎｅｗ', 'café', 'café', '(a\nb)', '()', '( )', 'new�', 'NEW. ', 'ne­w'];
const PLAIN_VALUES = ['new', 'New', '7', '_new', '%5Fnew', 'list', 'icon', 'a b', 'main', 'orders', 'new.json', 'x', '%', '%zz', '%6eew'];
const WIDE_VALUES = ['new ', 'new​', 'ｎｅｗ', 'café', 'café', 'new\ud800', 'new\udc00', 'ab\ud83d', '..', '.', 'a/b'];
const DYNAMIC = ['[id]', '[slug]', '[shopId]'];
const FIXED = ['orders', 'shops', '(g)', '(h)', '@m', 'Orders'];
const LEAVES = ['page.tsx', 'layout.tsx', 'index.tsx', 'x'];
const ROOTS = ['app', 'src/app', 'pages', 'src/pages', 'public', 'app', 'app'];

interface Query {
  input: Omit<StaticShadowInput, 'root'>;
}
interface Case {
  root: string;
  queries: Query[];
}

function makeCase(gen: Gen, wide: boolean): Case {
  const names = wide ? [...PLAIN_NAMES, ...WIDE_NAMES] : PLAIN_NAMES;
  const values = wide ? [...PLAIN_VALUES, ...WIDE_VALUES] : PLAIN_VALUES;
  const service = gen.weighted<string>([[8, 'web'], [1, ''], [1, 'apps/web']]);
  const base = service === '' ? '' : `${service}/`;
  const files: string[] = [];
  for (const _ of gen.list(2, 14, () => 0)) {
    const root = gen.pick(ROOTS);
    const segments = gen.list(0, 3, () => gen.weighted<string>([[5, gen.pick(FIXED)], [3, gen.pick(names)], [1, gen.pick(DYNAMIC)]]));
    files.push(`${base}${[root, ...segments, gen.pick(LEAVES)].join('/')}`);
  }
  const links: Record<string, string> = {};
  for (const _ of gen.list(0, 2, () => 0)) {
    if (!gen.chance(0.35)) continue;
    const root = gen.pick(ROOTS);
    const segments = gen.list(0, 2, () => gen.pick([...FIXED, ...names]));
    const target = gen.weighted<string>([[2, '/workspace/web/x'], [1, '@root/' + base + 'app']]);
    links[`${base}${[root, ...segments].join('/')}`] = target;
  }
  if (gen.chance(0.1)) files.push(`${base}public`);
  const root = buildProject(files, links);

  const queries: Query[] = [];
  for (let index = 0; index < QUERIES; index += 1) {
    const router = gen.weighted<string>([[6, 'app'], [2, 'src/app']]);
    const segments = gen.list(1, 4, () => gen.weighted<string>([[4, gen.pick(DYNAMIC)], [3, gen.pick(FIXED)], [1, gen.pick(names)]]));
    if (!segments.some((segment) => DYNAMIC.includes(segment))) segments.push(gen.pick(DYNAMIC));
    const leaf = gen.weighted<string>([[12, 'page.tsx'], [1, 'page.mdx'], [1, 'layout.tsx'], [1, 'page.css']]);
    const pageFile = `${base}${[router, ...segments, leaf].join('/')}`;
    const dynamicNames = [...new Set(segments.map((segment) => /^\[([^[\]]+)\]$/.exec(segment)?.[1]).filter((name): name is string => name !== undefined))];
    const filled: Record<string, string> = {};
    for (const name of dynamicNames) {
      const roll = gen.int(40);
      if (roll === 0) continue; // 값 없음
      filled[name] = roll === 1 ? '' : gen.pick(values);
    }
    const check = new Set(dynamicNames.filter(() => gen.chance(0.8)));
    const servicePath = gen.weighted<string>([[10, service], [1, `./${service}/`], [1, `${service}\\`]]);
    const maxFolders = gen.chance(0.2) ? 1 + gen.int(8) : undefined;
    const input: Query['input'] = { servicePath, pageFile: gen.chance(0.05) ? pageFile.replaceAll('/', '\\') : pageFile, values: filled, check, ...(maxFolders === undefined ? {} : { maxFolders }) };
    queries.push({ input });
  }
  return { root, queries };
}

type Outcome = { threw: true; message: string } | { threw: false; shadows: Array<{ name: string; value: string; where: string }> };

async function outcomeOf(find: typeof findNew, root: string, input: Query['input']): Promise<Outcome> {
  try {
    return { threw: false, shadows: (await find({ root, ...input })).map((s) => ({ name: s.name, value: s.value, where: s.where })) };
  } catch (error) {
    if (error instanceof Error && error.name === 'StaticShadowUnknownError') return { threw: true, message: error.message };
    throw error;
  }
}

/** 거부한 이름: 던지면 확인 대상 전부, 아니면 겹친 이름 */
function rejected(outcome: Outcome, input: Query['input']): Set<string> {
  return outcome.threw ? new Set(input.check) : new Set(outcome.shadows.map((shadow) => shadow.name));
}

interface Stats {
  runs: number;
  same: number;
  differ: number;
  openFlips: number;
  shadowed: number;
  empty: number;
  threw: number;
  stricter: number;
  controls: Record<string, number>;
}

async function run(wide: boolean): Promise<Stats> {
  const stats: Stats = { runs: 0, same: 0, differ: 0, openFlips: 0, shadowed: 0, empty: 0, threw: 0, stricter: 0, controls: { 'maxFolders+1': 0, '값+x': 0, '확인 이름 하나 빼기': 0 } };
  for (const seed of SEEDS) {
    const gen = new Gen(seed * (wide ? 31 : 17));
    for (let index = 0; index < PROJECTS; index += 1) {
      const { root, queries } = makeCase(gen, wide);
      for (const { input } of queries) {
        const before = await outcomeOf(findLegacy, root, input);
        const after = await outcomeOf(findNew, root, input);
        stats.runs += 1;
        if (before.threw) stats.threw += 1;
        else if (before.shadows.length > 0) stats.shadowed += 1;
        else stats.empty += 1;
        const identical = JSON.stringify(before) === JSON.stringify(after);
        if (identical) stats.same += 1;
        else {
          stats.differ += 1;
          const was = rejected(before, input);
          const now = rejected(after, input);
          const flipped = [...was].filter((name) => !now.has(name));
          if (flipped.length > 0) stats.openFlips += 1;
          else stats.stricter += 1;
          if (!wide) expect({ before, after, input }, '보통 이름은 옛 것과 글자까지 같아야 한다').toEqual({ before, after: before, input });
        }
        // 대조 장치: 옛 구현에 바꾼 입력을 넣으면 새 구현과 달라져야 한다(달라진 횟수를 센다)
        const controls: Array<[string, Query['input']]> = [
          ['maxFolders+1', { ...input, maxFolders: (input.maxFolders ?? 2000) + 1 }],
          ['값+x', { ...input, values: Object.fromEntries(Object.entries(input.values).map(([name, value]) => [name, `${value}x`])) }],
          ['확인 이름 하나 빼기', { ...input, check: new Set([...input.check].slice(1)) }],
        ];
        for (const [label, changed] of controls) {
          const mutated = await outcomeOf(findLegacy, root, changed);
          if (JSON.stringify(mutated) !== JSON.stringify(after)) stats.controls[label] = (stats.controls[label] ?? 0) + 1;
        }
      }
    }
  }
  return stats;
}

describe('findStaticShadows 차등(ADR-191 3aa): 옛 TS와 새 껍데기', () => {
  for (const wide of [false, true]) {
    it(`${wide ? '넓힌 이름이 섞인' : '보통 이름의'} 입력: ${wide ? '열린 쪽 뒤집힘 0' : '글자까지 같다'}`, async () => {
      const stats = await run(wide);
      if (REPORT) {
        console.log(
          `[차등] ${wide ? '넓힌 이름' : '보통 이름'}: 비교 ${stats.runs}, 같음 ${stats.same}, 다름 ${stats.differ}(더 막는 쪽 ${stats.stricter}, 열린 쪽 뒤집힘 ${stats.openFlips}) | 옛 결과 분포: 겹침 ${stats.shadowed}, 빈 결과 ${stats.empty}, 모름(던짐) ${stats.threw} | 대조 장치로 달라진 수 ${JSON.stringify(stats.controls)}`,
        );
      }
      expect(stats.shadowed).toBeGreaterThan(stats.runs * 0.03);
      expect(stats.empty).toBeGreaterThan(stats.runs * 0.1);
      expect(stats.threw).toBeGreaterThan(stats.runs * 0.03);
      expect(stats.openFlips).toBe(0);
      if (!wide) expect(stats.differ).toBe(0);
      else expect(stats.differ).toBeGreaterThan(0);
      for (const count of Object.values(stats.controls)) expect(count).toBeGreaterThan(0);
    });
  }
});
