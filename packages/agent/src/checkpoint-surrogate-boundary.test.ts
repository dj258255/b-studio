import { decodeNative, encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { legacy } from './checkpoint-git-legacy';
import { gitEnvFrom, stagedMismatchOf } from './checkpoints';
import { Gen, readEnvNumber } from './differential-kit';
import { decodeLoneSurrogates } from './lone-surrogates';

/**
 * 짝 없는 서로게이트가 napi 경계에서 모두 U+FFFD가 되는 문제(ADR-191 3s). 열린 쪽으로 이어지는 두 자리를 본다.
 * - 스테이지 불일치(막는 검사): 기대 경로와 git이 낸 경로를 견준다. 서로 다른 두 경로가 U+FFFD로 합쳐져 "같다"가 되면 불일치를 놓친다.
 * - 작성자 비교(참이면 트레일러를 통과 기록으로 믿는다): 서로 다른 두 이메일이 합쳐져 "같다"가 되면 남의 커밋을 믿는다.
 * 견줄 두 글자를 `encodeLoneSurrogates`(단사)로 바꿔 보내고(git 쪽 예약 글자는 Rust가 같은 규칙으로 바꾼다), 경로는 돌려받아 되돌린다.
 * 성질: 옛 구현(JS 문자열 비교)이 "다르다"인데 새 구현이 "같다"인 쌍은 0이고, 그 반대도 0이다. 인코딩을 빼면 열린 쪽 뒤집힘이 생기는지로 시험 자체를 확인한다.
 * 거부 목록 쪽(환경 변수 이름의 GIT_*, 위험 설정 키)은 U+FFFD로 합쳐져도 더 막을 뿐이라 인코딩하지 않는다: 이름이 아니라 자리로 답해 지워진다.
 * 크기는 SURROGATE_PAIRS 환경 변수로 바꾼다.
 */
const ALPHABET = ['\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '�', '', '', '', '', '', '', '', '', '', 'a', 'b', 'd', '8', '0', '/'];
const PAIRS = readEnvNumber('SURROGATE_PAIRS', 30_000);

const wellFormed = (text: string) => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
/** git이 낼 수 있는 경로: 짝 없는 서로게이트가 없다(유효한 UTF-8을 읽은 것) */
const gitSide = (text: string) => wellFormed(text);

function pair(g: Gen): [string, string] {
  const a = g.text(ALPHABET, 1 + g.int(6));
  const mode = g.int(4);
  if (mode === 0) return [a, g.text(ALPHABET, 1 + g.int(5))];
  if (mode === 1) return [a, a];
  const at = g.int(a.length);
  return [a, mode === 2 ? a.slice(0, at) + g.pick(ALPHABET) + a.slice(at + 1) : wellFormed(a)];
}

describe('짝 없는 서로게이트 경계', () => {
  it('encodeLoneSurrogates는 되돌릴 수 있다', () => {
    const g = new Gen(7);
    for (let i = 0; i < PAIRS; i++) {
      const text = g.text(ALPHABET, g.int(8));
      expect(decodeLoneSurrogates(encodeLoneSurrogates(text))).toBe(text);
    }
  });

  it('스테이지 불일치: 서로 다른 경로가 같아지지 않는다(옛 구현과 같은 판정)', () => {
    const g = new Gen(11);
    let opened = 0;
    let closed = 0;
    let unencodedOpened = 0;
    let mismatches = 0;
    for (let i = 0; i < PAIRS; i++) {
      const [expectedPath, anyPath] = pair(g);
      const actualPath = gitSide(anyPath);
      const ls = `100644 aaa 0\t${actualPath}\0`;
      const staged = `${actualPath}\0`;
      const expected = new Map([[expectedPath, 'blob:aaa']]);
      const before = legacy.stagedMismatch(ls, staged, '', expected);
      const after = stagedMismatchOf(ls, staged, '', expected);
      if (before.length > 0) mismatches++;
      expect(after).toEqual(before);
      if (before.length > 0 && after.length === 0) opened++;
      if (before.length === 0 && after.length > 0) closed++;
      // 대조: 인코딩 없이 Rust로 보내면 짝 없는 서로게이트가 U+FFFD가 되어 열린 쪽 뒤집힘이 생긴다
      const naive = native.checkpointStagedMismatch(ls, staged, '', [expectedPath], ['blob:aaa']);
      if (before.length > 0 && naive.length === 0) unencodedOpened++;
    }
    console.log(`스테이지 불일치 서로게이트: 쌍 ${PAIRS}, 옛 불일치 ${mismatches}, 열린 쪽 ${opened}, 닫는 쪽 ${closed}, 인코딩 없이 보냈다면 열린 쪽 ${unencodedOpened}`);
    expect(mismatches).toBeGreaterThan(PAIRS / 10);
    expect(opened).toBe(0);
    expect(closed).toBe(0);
    expect(unencodedOpened).toBeGreaterThan(0);
  });

  it('작성자 비교: 서로 다른 이메일이 같아지지 않는다', () => {
    const g = new Gen(13);
    let opened = 0;
    let closed = 0;
    let unencodedOpened = 0;
    let trues = 0;
    for (let i = 0; i < PAIRS; i++) {
      const [ours, anyEmail] = pair(g);
      const gitEmail = gitSide(anyEmail);
      const before = legacy.sessionRecords(`s\0h\0subject\0body\0${gitEmail}\0a\0b\0c\x1e`, ours)[0]!.ours;
      const after = (decodeNative(native.checkpointSessionRecords(`s\0h\0subject\0body\0${gitEmail}\0a\0b\0c\x1e`, encodeLoneSurrogates(ours))) as Array<{ ours: boolean }>)[0]!.ours;
      if (before) trues++;
      expect(after).toBe(before);
      if (!before && after) opened++;
      if (before && !after) closed++;
      if (!before && native.checkpointAuthorIsOurs(gitEmail, wellFormed(ours))) unencodedOpened++;
    }
    console.log(`작성자 비교 서로게이트: 쌍 ${PAIRS}, 옛 같음 ${trues}, 열린 쪽 ${opened}, 닫는 쪽 ${closed}, 인코딩 없이 보냈다면 열린 쪽 ${unencodedOpened}`);
    expect(trues).toBeGreaterThan(PAIRS / 10);
    expect(opened).toBe(0);
    expect(closed).toBe(0);
    expect(unencodedOpened).toBeGreaterThan(0);
  });

  it('환경 변수 이름: 짝 없는 서로게이트가 든 GIT_* 이름도 지운다', () => {
    const g = new Gen(17);
    let removed = 0;
    for (let i = 0; i < PAIRS / 10; i++) {
      const suffix = `${g.text(ALPHABET, g.int(4))}${g.pick(['\ud800', '\udc00', 'x', '\ufffd'])}`;
      const env: Record<string, string> = { [`GIT_${suffix}`]: 'x', [`GIT_AUTHOR_NAME${suffix}`]: 'x', KEEP: 'y' };
      const result = gitEnvFrom(env);
      expect(result.KEEP).toBe('y');
      for (const key of Object.keys(env)) {
        if (key !== 'KEEP') {
          expect(key in result, key).toBe(false);
          removed++;
        }
      }
    }
    expect(removed).toBeGreaterThan(0);
  });
});
