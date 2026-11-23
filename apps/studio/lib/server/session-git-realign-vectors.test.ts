import { describe, expect, it } from 'vitest';
import {
  alignedAfterAction,
  dbRestoreBase,
  decideInitialMemory,
  decideRealign,
  decideRemember,
  describeRestoreReason,
  KEPT_UNKNOWN,
  mergeKept,
  planRevert,
  rememberAfterRevert,
  restoreKept,
  revertNeedsRealign,
  revertTail,
  splitLocalEdits,
  type Aligned,
  type OriginRead,
} from './session-git-realign';
import { frozenModule, loadTable } from './frozen-vectors';

const FROZEN = loadTable(new URL('./session-git-realign-vectors.json', import.meta.url));
const { legacyInitialMemory, legacyRealign, legacyRemember, legacyRememberAfterRevert, legacyRevertPlan, legacyRevertTail, legacySplitLocalEdits } = frozenModule(FROZEN, 'session-git-realign-legacy:');

/**
 * 코어(Rust `git_realign`)의 판정을 옛 판정이 낸 값(`session-git-realign-vectors.json`, 입력별로 고정)과 견준다(ADR-218). `legacy*` 함수는 고정한 값을 꺼내는 껍데기다. 사실 조합 전체를 돌고, 다른 칸은 의도한 것만 모두 적는다.
 * 다른 칸은 모두 닫는 쪽이다(옛 코드가 열어 둔 것을 닫거나 같다).
 */

const REMEMBERED = { branch: 'main', lastCheckpoint: 'r' };
const HEADS = ['r', 'x', '', 'R', 'r '];
const BRANCHES: Array<string | undefined> = ['main', 'other', undefined, 'Main', 'main ', ''];

describe('맞추기 판정: 사실 조합 전체가 옛 판정이 낸 값과 같다', () => {
  for (const head of HEADS) {
    for (const branch of BRANCHES) {
      for (const ancestor of [true, false]) {
        for (const allowUnwind of [true, false]) {
          const name = `head=${JSON.stringify(head)} branch=${String(branch)} ancestor=${ancestor} allowUnwind=${allowUnwind}`;
          it(name, () => {
            const facts = { rememberedHead: REMEMBERED.lastCheckpoint, rememberedBranch: REMEMBERED.branch, head, branch, allowUnwind };
            let step = decideRealign(facts);
            // 같은 브랜치에서 HEAD만 다를 때만 조상을 읽는다(옛 코드도 그때만 읽었다)
            if (step.kind === 'need_ancestor') step = decideRealign({ ...facts, ancestor });
            const old = legacyRealign(REMEMBERED, { head, branch }, ancestor, allowUnwind);
            expect(step.kind).toBe(old.kind);
            if (step.kind === 'restore' && old.kind === 'restore') expect(describeRestoreReason(step.reason, branch)).toBe(old.which);
          });
        }
      }
    }
  }
  it('조상은 같은 브랜치에서 HEAD만 다를 때만 읽는다', () => {
    const asks = (head: string, branch: string | undefined) => decideRealign({ rememberedHead: 'r', rememberedBranch: 'main', head, branch, allowUnwind: true }).kind === 'need_ancestor';
    expect(asks('x', 'main')).toBe(true);
    expect(asks('r', 'main')).toBe(false);
    expect(asks('x', 'other')).toBe(false);
    expect(asks('x', undefined)).toBe(false);
    expect(asks('', 'main')).toBe(true);
  });
  it('사례 수', () => {
    expect(HEADS.length * BRANCHES.length * 4).toBe(120);
  });
});

describe('풀거나 되돌린 뒤 끝 상태를 다시 읽어 기억과 견준다(N14)', () => {
  it('같을 때만 받아들인다. 읽지 못했거나 어긋났으면 받아들이지 않는다', () => {
    expect(alignedAfterAction(REMEMBERED, { head: 'r', branch: 'main' })).toBe(true);
    expect(alignedAfterAction(REMEMBERED, { head: 'r', branch: 'agent' })).toBe(false);
    expect(alignedAfterAction(REMEMBERED, { head: 'x', branch: 'main' })).toBe(false);
    expect(alignedAfterAction(REMEMBERED, { head: 'r', branch: undefined })).toBe(false);
    expect(alignedAfterAction(REMEMBERED, undefined)).toBe(false);
  });
  it('옛 판정은 이 확인이 없었다: 풀기 명령이 성공하면 믿었다(의도한 차이, 닫는 쪽)', () => {
    // 옛 코드에서 same이 아닌 모든 읽기는 행동 뒤 다시 읽지 않았다. 새 코드는 행동 뒤 같음을 요구한다
    expect(legacyRealign(REMEMBERED, { head: 'x', branch: 'main' }, true, true).kind).toBe('unwind');
    expect(decideRealign({ rememberedHead: 'r', rememberedBranch: 'main', head: 'x', branch: 'main', ancestor: true, allowUnwind: true }).kind).toBe('unwind');
  });
});

describe('기억할 값', () => {
  const heads = ['', 'h'];
  const branches: Array<string | undefined> = [undefined, 'main'];
  const createds: Array<string | undefined> = [undefined, 'c', ''];
  for (const head of heads) {
    for (const branch of branches) {
      for (const created of createds) {
        it(`rememberGit head=${JSON.stringify(head)} branch=${String(branch)} created=${String(created)}`, () => {
          expect(decideRemember({ head, branch }, created)).toEqual(legacyRemember({ head, branch }, created));
        });
      }
    }
  }
  it('머리를 읽지 못하면(undefined) 기억하지 않는다', () => {
    expect(decideRemember(undefined, 'c')).toBeUndefined();
  });
  const origins: Array<{ origin: OriginRead; legacy: string | undefined }> = [
    { origin: { kind: 'none' }, legacy: undefined },
    { origin: { kind: 'url', url: 'git@x:y.git' }, legacy: 'git@x:y.git' },
    { origin: { kind: 'url', url: '' }, legacy: '' },
  ];
  for (const head of heads) {
    for (const branch of branches) {
      for (const { origin, legacy } of origins) {
        it(`initialGitMemory head=${JSON.stringify(head)} branch=${String(branch)} origin=${origin.kind}`, () => {
          expect(decideInitialMemory({ head, branch }, origin)).toEqual(legacyInitialMemory({ head, branch }, legacy));
        });
      }
    }
  }
  it('다른 칸: 원격 주소를 읽지 못하면 기억하지 않는다(옛 코드는 원격 없음으로 기억했다. 닫는 쪽)', () => {
    expect(legacyInitialMemory({ head: 'h', branch: 'main' }, undefined)).toEqual({ branch: 'main', lastCheckpoint: 'h' });
    expect(decideInitialMemory({ head: 'h', branch: 'main' }, { kind: 'failed' })).toBeUndefined();
  });
});

describe('되돌리기 조합: 순서와 기억·남은 일', () => {
  const kinds: Aligned[] = ['same', 'unwound', 'restored', 'unrestorable'];
  const different: string[] = [];
  for (const aligned of kinds) {
    for (const readOnly of [false, true]) {
      it(`계획 aligned=${aligned} readOnly=${readOnly}`, () => {
        const plan = planRevert(aligned, readOnly);
        const old = legacyRevertPlan(aligned);
        if (JSON.stringify(plan) !== JSON.stringify(old)) {
          different.push(`${aligned}/readOnly=${readOnly}: protectDocs ${String(old.kind === 'discard' && old.protectDocs)} → ${plan.kind === 'discard' ? String(plan.protectDocs) : plan.kind}`);
          // 다른 칸은 읽기만 요청의 문서 지키기뿐이고, 지키지 않는 쪽(닫는 쪽)이다
          expect(readOnly).toBe(true);
          expect(plan).toEqual({ kind: 'discard', protectDocs: false });
        }
      });
    }
  }
  it('다른 칸 목록(의도한 것만): 읽기만 요청이 버리기로 가는 두 칸', () => {
    expect(different.sort()).toEqual(['same/readOnly=true: protectDocs true → false', 'unwound/readOnly=true: protectDocs true → false']);
  });
  it('알아보지 못한 맞춤 결과는 되돌리지 못한 것이다', () => {
    expect(planRevert('weird' as Aligned, false)).toEqual({ kind: 'fail' });
  });
  for (const docs of [true, false]) {
    for (const untrusted of [true, false]) {
      it(`되돌린 뒤 기억 docs=${docs} untrusted=${untrusted}`, () => {
        expect(rememberAfterRevert(docs, untrusted)).toBe(legacyRememberAfterRevert(docs, untrusted));
      });
    }
  }
  for (const filesEmpty of [true, false]) {
    for (const databaseTouched of [true, false]) {
      for (const alsoRestartEmpty of [true, false]) {
        for (const hostOnly of [true, false]) {
          it(`남은 일 files=${filesEmpty ? 0 : 1} db=${databaseTouched} alsoRestart=${alsoRestartEmpty ? 0 : 1} hostOnly=${hostOnly}`, () => {
            expect(revertTail(filesEmpty, databaseTouched, alsoRestartEmpty, hostOnly)).toBe(legacyRevertTail(filesEmpty, databaseTouched, alsoRestartEmpty, hostOnly));
          });
        }
      }
    }
  }
  it('맞추기는 이 컴퓨터 방식이고 기억이 있을 때만 한다', () => {
    expect([revertNeedsRealign(true, true), revertNeedsRealign(true, false), revertNeedsRealign(false, true), revertNeedsRealign(false, false)]).toEqual([true, false, false, false]);
  });
  it('DB 복원 기준점은 문서를 지키기 전의 체크포인트다', () => {
    expect(dbRestoreBase('before', 'docs')).toBe('before');
    expect(dbRestoreBase('before', undefined)).toBe('before');
  });
});

/** 시드 난수 */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 독립 오라클: ASCII 이름의 넓은 맞춤(대소문자, 끝의 점·공백, 역슬래시, 겹친 구분자, `.` 조각) */
function key(file: string): string {
  return file
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .map((part) => part.toLowerCase().replace(/[. ]+$/, ''))
    .join('/');
}
function oracleMatches(a: string, b: string): boolean {
  const [x, y] = [key(a), key(b)];
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

describe('직접 수정 가르기', () => {
  it('남긴 에이전트 변경이 없으면 옛 판정과 같다: 바뀐 파일 전부가 직접 수정이다', () => {
    for (const pending of [[], ['a'], ['a', 'b/c', 'D.txt']]) {
      const split = splitLocalEdits(pending, []);
      expect({ human: split.human, agent: split.agent }).toEqual(legacySplitLocalEdits(pending));
      expect(split.kept).toEqual([]);
    }
  });

  it('무작위 경로 1000건: 나눔은 겹치지 않고 빠지지 않으며, 오라클이 맞는다고 보는 것은 모두 에이전트 변경이다', () => {
    const random = prng(20261118);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const parts = ['api', 'Api', 'src', 'SRC', 'Order.java', 'order.java', 'Order.java.', 'x', 'X', 'a b', 'docs', '.hidden', 'z '];
    const seps = ['/', '/', '/', '//', '\\', '/./'];
    const makePath = (): string => {
      const depth = 1 + Math.floor(random() * 3);
      let out = pick(parts);
      for (let i = 1; i < depth; i += 1) out += pick(seps) + pick(parts);
      return out;
    };
    let agentSeen = 0;
    let humanSeen = 0;
    for (let round = 0; round < 1000; round += 1) {
      const pending = Array.from({ length: 1 + Math.floor(random() * 5) }, makePath);
      const kept = Array.from({ length: Math.floor(random() * 4) }, makePath);
      const split = splitLocalEdits(pending, kept);
      // 파일마다 직접 수정이거나 변경이다(둘 다도 아니고 둘 다도 아니다)
      expect([...split.human, ...split.agent].sort()).toEqual([...pending].sort());
      for (const file of pending) {
        const expectedAgent = kept.some((entry) => oracleMatches(file, entry));
        expect(split.agent.includes(file), `${file} kept=${JSON.stringify(kept)}`).toBe(expectedAgent);
        if (expectedAgent) agentSeen += 1;
        else humanSeen += 1;
      }
      // 기억은 지금도 바뀌어 있는 항목만 남는다
      for (const entry of split.kept) expect(pending.some((file) => oracleMatches(file, entry))).toBe(true);
    }
    expect(agentSeen).toBeGreaterThan(200);
    expect(humanSeen).toBeGreaterThan(200);
  });

  it('이름을 읽는 규칙: 유니코드 정규화·보이지 않는 문자·`..`는 넓게 맞춘다(에이전트 변경으로 본다)', () => {
    const kept = ['한글.txt', 'Api/Order.java'];
    const nfd = '한글.txt'.normalize('NFD');
    expect(splitLocalEdits([nfd], kept).agent).toEqual([nfd]);
    expect(splitLocalEdits(['Api/Order​.java'], kept).agent).toEqual(['Api/Order​.java']);
    expect(splitLocalEdits(['api/ORDER.JAVA'], kept).agent).toEqual(['api/ORDER.JAVA']);
    // 알아볼 수 없는 이름은 모두 에이전트 변경이다
    expect(splitLocalEdits(['../x'], ['z']).agent).toEqual(['../x']);
    expect(splitLocalEdits(['a', 'b'], [KEPT_UNKNOWN]).human).toEqual([]);
    // 이름이 이어져 보이기만 하는 다른 파일은 사람의 수정이다
    expect(splitLocalEdits(['xy'], ['x']).human).toEqual(['xy']);
  });

  it('기억의 합치기와 읽기: 옛 파일(없음)은 없고, 모양이 틀리면 모든 파일이다', () => {
    expect(mergeKept(['b', 'a'], ['a', 'c'])).toEqual(['a', 'b', 'c']);
    expect(restoreKept(undefined)).toBeUndefined();
    expect(restoreKept([])).toBeUndefined();
    expect(restoreKept(['b', 'a', 'a'])).toEqual(['a', 'b']);
    expect(restoreKept('a')).toEqual([KEPT_UNKNOWN]);
    expect(restoreKept({ a: 1 })).toEqual([KEPT_UNKNOWN]);
    expect(restoreKept(['a', 3, null])).toEqual(['..', 'a']);
  });
});
