import { readFileSync } from 'node:fs';
import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';
import { foldName as legacyFold } from './path-policy-legacy';

/**
 * `foldName`(거부 목록용 넓은 접기)을 Rust로 옮기면서(ADR-191 3q, #1090) 옛 TS와 전체 코드 포인트로 견준다.
 * NFKD·NFKC·`\p{M}\p{Cf}`·대소문자 접기는 Node(ICU)와 Rust(`unicode-normalization`·`regex`·std)의 Unicode 판이 갈릴 수 있어, 무작위 시험으로는 부족하다.
 *
 * 0~0x10FFFF(서로게이트 제외) 글자 하나마다 `c`, `a`+`c`, `c`+`a`, `c`+`.` 네 가지를 옛 구현과 새 구현에 넣는다.
 * 다른 결과는 `path-policy-fold-diffs.json`에 Node의 Unicode 판별로 고정했다: Node 22.17(Unicode 16.0)에서 176개, Node 22.23(ICU 78.3, Unicode 17.0)에서 105개 글자다.
 * 모두 그 Node의 Unicode가 아직 배정하지 않은 글자라 옛 구현은 그대로 두고(접지 않고), 새 구현은 더 새 표(std 17, `unicode-normalization` 18)대로 접거나 결합 문자로 지운다.
 * 거부 목록에서 더 많은 이름을 같은 꼴로 모으는 쪽(더 막는 쪽)이다. 결합 문자는 `regex`의 `\p{M}`(Unicode 16)과 `unicode-normalization`(Unicode 18)의 합집합으로
 * 지운다. `regex` 표만 쓰면 Unicode 17 Node가 지우는 새 결합 문자를 남겨 열린 쪽 뒤집힘 42개가 났다(트러블슈팅 166 덧붙임).
 *
 * 그 밖의 차이는 한 종류뿐이다: 옛 구현은 점·공백만 남는 이름(`.`, `́.`)을 그대로 두었고, 새 구현은 끝의 점·공백을 모두 잘라 빈 이름으로 모은다.
 * 결합 문자를 Node보다 넓게 지우면 이렇게 해야만 어느 판에서도 열린 쪽이 없다. Unicode 17 결합 문자 `u`를 Unicode 16 Node의 옛 구현은 글자로 보아
 * `u`와 `u.`를 같은 꼴로 모으고, Unicode 17 Node의 옛 구현은 `u`를 빈 이름과, `u.`을 `.`과 모은다. 두 판보다 좁지 않으려면 빈 이름과 `.`이 같은 꼴이어야 한다.
 *
 * **열린 쪽 뒤집힘을 따로 확인한다**: 옛 구현이 같은 꼴로 모으던 두 이름을 새 구현이 다른 꼴로 가르면 거부 목록이 이름 하나를 놓친다.
 * 시험한 모든 입력에서 "옛 결과가 같으면 새 결과도 같다"가 성립해야 하고(옛 분할을 새 분할이 세분하지 않는다), 규칙 이름(`.git`·`.env`)의 글자 하나를 바꾼 이름도 같게 본다.
 */
type Pinned = Array<[hex: string, folded: string]>;
/** Node의 Unicode 판 → 그 판에서 옛 구현과 다른 글자. 목록이 없는 판에서는 고정 목록 비교만 건너뛰고, 열린 쪽 검사는 어느 판에서도 한다 */
const PINNED_BY_UNICODE = JSON.parse(readFileSync(new URL('./path-policy-fold-diffs.json', import.meta.url), 'utf8')) as Record<string, Pinned>;
const PINNED_COUNT: Record<string, number> = { '16.0': 176, '17.0': 105 };
const PINNED = PINNED_BY_UNICODE[process.versions.unicode ?? ''];

function* codePoints(): Generator<number> {
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield cp;
  }
}

describe('foldName 전체 코드 포인트 비교(옛 TS와 Rust)', () => {
  const differing = new Map<number, string[]>();
  const oldToNew = new Map<string, string>();
  const conflicts: string[] = [];
  let compared = 0;
  let newClasses = 0;

  it('0~0x10FFFF 글자마다 네 가지 문맥을 견주고, 옛 결과가 같으면 새 결과도 같다', () => {
    const newByOld = new Map<string, Set<string>>();
    for (const cp of codePoints()) {
      const c = String.fromCodePoint(cp);
      for (const s of [c, `a${c}`, `${c}a`, `${c}.`]) {
        compared += 1;
        const o = legacyFold(s);
        const n = native.foldName(s);
        if (o !== n) {
          const list = differing.get(cp) ?? [];
          list.push(s);
          differing.set(cp, list);
        }
        let set = newByOld.get(o);
        if (!set) newByOld.set(o, (set = new Set()));
        set.add(n);
        oldToNew.set(s, n);
      }
    }
    for (const [o, set] of newByOld) if (set.size > 1) conflicts.push(`옛 ${JSON.stringify(o)} → 새 ${JSON.stringify([...set])}`);
    newClasses = new Set([...newByOld.values()].flatMap((set) => [...set])).size;
    expect(compared).toBe((0x110000 - 0x800) * 4);
    // 열린 쪽 뒤집힘: 옛 구현이 하나로 모으던 입력을 새 구현이 가르면 안 된다
    expect(conflicts.slice(0, 5)).toEqual([]);
    // 새 구현의 꼴 수는 옛 구현보다 같거나 적다(더 많이 모은다)
    expect(newClasses).toBeLessThanOrEqual(newByOld.size);
  }, 600_000);

  it('고정 목록은 판마다 정해 둔 수이고, 판이 올라가면 줄기만 한다', () => {
    expect(Object.keys(PINNED_BY_UNICODE).sort()).toEqual(Object.keys(PINNED_COUNT).sort());
    for (const [version, count] of Object.entries(PINNED_COUNT)) expect(PINNED_BY_UNICODE[version]?.length, version).toBe(count);
    // 새 판의 Node는 옛 구현이 접는 글자가 늘 뿐이라, 새 판의 차이는 옛 판 차이의 부분집합이다
    const u16 = new Set(PINNED_BY_UNICODE['16.0']?.map(([hex]) => hex));
    expect(PINNED_BY_UNICODE['17.0']?.filter(([hex]) => !u16.has(hex))).toEqual([]);
  });

  it('다른 결과는 이 Node 판의 고정 목록(옛 구현이 접지 않던 미배정 글자, 네 문맥 모두 다름)과 점·공백만 남는 이름뿐이다', () => {
    if (!PINNED) {
      // 목록이 없는 Unicode 판의 Node에서는 고정 목록이 맞지 않을 수 있다. 판이 다르다는 것만 남기고 위의 열린 쪽 검사에 맡긴다
      console.warn(`Node의 Unicode 판이 ${process.versions.unicode}이라 고정 목록 비교를 건너뜁니다(고정은 ${Object.keys(PINNED_BY_UNICODE).join(', ')})`);
      return;
    }
    const pinnedCps = PINNED.map(([hex]) => Number.parseInt(hex, 16));
    const fullyDiffering = [...differing].filter(([cp, inputs]) => inputs.length === 4 && legacyFold(String.fromCodePoint(cp)) === String.fromCodePoint(cp));
    expect(fullyDiffering.map(([cp]) => cp).sort((a, b) => a - b)).toEqual([...pinnedCps].sort((a, b) => a - b));
    for (const [hex, folded] of PINNED) {
      const cp = Number.parseInt(hex, 16);
      const c = String.fromCodePoint(cp);
      expect(differing.get(cp)?.length, hex).toBe(4);
      // 옛 구현은 이 글자를 접지 않는다(미배정 글자는 그대로), 새 구현은 접은 꼴을 낸다
      expect(legacyFold(c), hex).toBe(c);
      expect(native.foldName(c), hex).toBe(folded);
      expect(folded, hex).not.toBe(c);
    }
    // 고정 목록 밖의 차이는 모두 "옛 구현은 점·공백만 남기고, 새 구현은 빈 이름"이다(빈 이름과 점·공백뿐인 이름을 한 꼴로 모은다)
    let dotOnly = 0;
    const pinnedSet = new Set(pinnedCps);
    for (const [cp, inputs] of differing) {
      if (pinnedSet.has(cp)) continue;
      for (const s of inputs) {
        expect(legacyFold(s), JSON.stringify(s)).toMatch(/^[. ]+$/);
        expect(native.foldName(s), JSON.stringify(s)).toBe('');
        dotOnly += 1;
      }
    }
    // `.`·공백·결합 문자 뒤의 `.` 따위가 실제로 들었다(시험이 비지 않았다)
    expect(dotOnly).toBeGreaterThan(2000);
    expect(PINNED.length).toBe(PINNED_COUNT[process.versions.unicode ?? '']);
  });

  it('규칙 이름(.git·.env·node_modules·workflows)의 글자 하나를 바꾼 이름: 옛 구현이 규칙과 같게 보던 것을 새 구현도 같게 본다', () => {
    const changed: number[] = [];
    for (const cp of codePoints()) {
      const c = String.fromCodePoint(cp);
      if (legacyFold(c) !== c.toLowerCase() || native.foldName(c) !== legacyFold(c)) changed.push(cp);
    }
    // 접는 글자(전각·켈빈·긴 s·악센트 따위)가 충분히 들었는지
    expect(changed.length).toBeGreaterThan(5000);
    let merged = 0;
    let newlyMerged = 0;
    const open: string[] = [];
    for (const rule of ['.git', '.env', 'node_modules', 'workflows', 'infra']) {
      const ruleOld = legacyFold(rule);
      const ruleNew = native.foldName(rule);
      expect(ruleNew).toBe(ruleOld);
      for (let i = 0; i < rule.length; i++) {
        for (const cp of changed) {
          const x = rule.slice(0, i) + String.fromCodePoint(cp) + rule.slice(i + 1);
          const sameOld = legacyFold(x) === ruleOld;
          const sameNew = native.foldName(x) === ruleNew;
          if (sameOld) merged += 1;
          if (sameOld && !sameNew) open.push(JSON.stringify(x));
          if (!sameOld && sameNew) newlyMerged += 1;
        }
      }
    }
    expect(open.slice(0, 5)).toEqual([]);
    // 옛 구현이 규칙과 같게 보던 이름이 실제로 있었다(시험이 비지 않았다). 새로 같게 보는 이름은 그 Node가 배정하지 않은 글자뿐이다
    expect(merged).toBeGreaterThan(50);
    expect(newlyMerged).toBeGreaterThanOrEqual(0);
  }, 600_000);

  it('글자 둘 이상의 무작위 문맥(결합 문자·시그마·대소문자 특수 규칙)에서도 같다', () => {
    const pool: string[] = ['a', 'A', '.', ' ', 'Σ', 'σ', 'ς', 'İ', 'ß', 'ŉ', 'ǰ', '́', 'ͅ', '‍', '．', '∕'];
    for (const cp of codePoints()) {
      // 이 Node가 배정하지 않아 옛 구현과 다르게 접는 글자(첫 시험이 잰 것)는 뺀다. 고정 목록이 없는 판에서도 같은 기준이다
      if (differing.get(cp)?.length === 4) continue;
      const c = String.fromCodePoint(cp);
      if (legacyFold(c) !== c) pool.push(c);
    }
    const g = new Gen(2026);
    const iterations = readEnvNumber('PATH_POLICY_CODEPOINT_RANDOM', 200_000);
    const bad: string[] = [];
    let dotOnly = 0;
    for (let i = 0; i < iterations; i++) {
      const s = g.text(pool, 2 + g.int(5));
      const o = legacyFold(s);
      const n = native.foldName(s);
      if (o === n) continue;
      // 점·공백만 남는 이름은 빈 이름으로 모은다(위 시험과 같은 의도한 차이)
      if (/^[. ]+$/.test(o) && n === '') dotOnly += 1;
      else bad.push(JSON.stringify(s));
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(dotOnly).toBeLessThan(iterations / 10);
  }, 600_000);
});
