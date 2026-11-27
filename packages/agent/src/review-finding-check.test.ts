import { describe, expect, it } from 'vitest';
import {
  buildReviewCheckNote,
  checkFindingLocations,
  checkFindingsAddressed,
  FINDING_LINE_CONTEXT,
  inlineCodeSpan,
  escapeMarkdownText,
  summarizeAddressRate,
} from './review-finding-check';
import { truncateDiff } from './pr-review';

/** src/a.ts: 12번 줄을 더하고(새 파일 기준), 51번 줄을 바꾼다. 옛 파일 기준으로는 50번 줄이 지워진다 */
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ fn',
  ' c10',
  ' c11',
  '+add12',
  ' c13',
  '@@ -50,2 +51,2 @@',
  '-old50',
  '+new51',
  ' c52',
  'diff --git a/docs/b.md b/docs/b.md',
  '--- a/docs/b.md',
  '+++ b/docs/b.md',
  '@@ -1,1 +1,2 @@',
  ' x',
  '+y',
].join('\n');

const reviewed = (diff: string = DIFF) => ({ diff, truncated: false, omittedFiles: [] as string[] });
const loc = (file: string, line?: number) => ({ file, ...(line === undefined ? {} : { line }) });
const one = (file: string, line?: number, diff?: string) => checkFindingLocations([loc(file, line)], reviewed(diff))[0]!;

describe('checkFindingLocations: 파일과 줄을 리뷰한 diff와 대조', () => {
  it('문맥 허용 줄 수는 git 기본 문맥(3)과 같다', () => {
    expect(FINDING_LINE_CONTEXT).toBe(3);
  });

  it('바뀐 줄과 문맥 안의 줄은 diff 안이다', () => {
    expect(one('src/a.ts', 12)).toEqual({ status: 'in_diff' });
    expect(one('src/a.ts', 15)).toEqual({ status: 'in_diff' });
    expect(one('src/a.ts', 9)).toEqual({ status: 'in_diff' });
  });

  it('문맥 허용을 넘는 줄은 diff에 없음(line_outside)', () => {
    expect(one('src/a.ts', 16)).toEqual({ status: 'not_in_diff', reason: 'line_outside' });
    expect(one('src/a.ts', 8)).toEqual({ status: 'not_in_diff', reason: 'line_outside' });
    expect(one('src/a.ts', 200)).toEqual({ status: 'not_in_diff', reason: 'line_outside' });
  });

  it('지운 줄은 옛 파일 줄 번호로 가리켜도 diff 안이다', () => {
    expect(one('src/a.ts', 50)).toEqual({ status: 'in_diff' });
  });

  it('옛 번호와 새 번호가 크게 어긋난 파일에서도 지운 줄을 옛 번호로 가리키면 diff 안이다', () => {
    const shifted = ['diff --git a/s.ts b/s.ts', '--- a/s.ts', '+++ b/s.ts', '@@ -100,2 +20,1 @@', '-gone100', ' keep'].join('\n');
    expect(one('s.ts', 100, shifted)).toEqual({ status: 'in_diff' });
    expect(one('s.ts', 60, shifted)).toEqual({ status: 'not_in_diff', reason: 'line_outside' });
  });

  it('diff에 없는 파일은 file_missing, 줄이 없는 지적은 파일만 본다', () => {
    expect(one('src/zzz.ts', 3)).toEqual({ status: 'not_in_diff', reason: 'file_missing' });
    expect(one('src/a.ts')).toEqual({ status: 'in_diff' });
  });

  it('경로 표기가 달라도(./, a/ b/ 접두, 대소문자, 역슬래시, 유니코드 정규화) 같은 파일로 본다', () => {
    for (const file of ['./src/a.ts', 'b/src/a.ts', 'a/src/a.ts', 'SRC/A.ts', 'src\\a.ts', 'src//a.ts', 'src/a.ts\u200b']) {
      expect(one(file, 12), file).toEqual({ status: 'in_diff' });
    }
    const nfd = '한글.ts'.normalize('NFD');
    const hangul = DIFF.replace(/src\/a\.ts/g, '한글.ts'.normalize('NFC'));
    expect(one(nfd, 12, hangul)).toEqual({ status: 'in_diff' });
  });

  it('읽을 수 없는 경로(절대 경로, .., 빈 값)는 확인 못 함이다', () => {
    for (const file of ['/etc/passwd', '../src/a.ts', 'src/../src/a.ts', 'C:\\x\\a.ts', '  ', '\u200b']) {
      expect(one(file, 12), file).toEqual({ status: 'unverified', reason: 'bad_location' });
    }
  });

  it('대소문자만 다른 파일이 둘이면 정확히 같은 쪽을 고르고, 정확히 같은 것이 없으면 확인 못 함', () => {
    const two = DIFF.replaceAll('docs/b.md', 'src/A.ts');
    expect(one('src/a.ts', 12, two)).toEqual({ status: 'in_diff' });
    expect(one('SRC/a.ts', 12, two)).toEqual({ status: 'unverified', reason: 'bad_location' });
  });

  it('크기 때문에 본문을 생략한 파일은 확인 못 함(거르지도 통과로 세지도 않는다)', () => {
    const cut = truncateDiff(DIFF, 230);
    expect(cut.omittedFiles.length).toBeGreaterThan(0);
    const [result] = checkFindingLocations([loc(cut.omittedFiles[0]!, 12)], cut);
    expect(result).toEqual({ status: 'unverified', reason: 'file_omitted' });
  });

  it('생략한 파일 목록 없이 뒷부분이 잘렸으면 못 찾은 파일·줄도 확인 못 함', () => {
    const tail = truncateDiff('가'.repeat(100), 10);
    expect(tail.truncated).toBe(true);
    expect(tail.omittedFiles).toEqual([]);
    expect(checkFindingLocations([loc('src/a.ts', 3)], tail)[0]).toEqual({ status: 'unverified', reason: 'diff_truncated' });
  });

  it('잘렸지만 그 파일이 아닌 생략이면 없는 파일은 그대로 diff에 없음', () => {
    const cut = truncateDiff(DIFF, 230);
    const kept = ['src/a.ts', 'docs/b.md'].find((p) => !cut.omittedFiles.includes(p))!;
    expect(checkFindingLocations([loc('nope.ts', 1)], cut)[0]).toEqual({ status: 'not_in_diff', reason: 'file_missing' });
    expect(checkFindingLocations([loc(kept)], cut)[0]).toEqual({ status: 'in_diff' });
  });

  it('바이너리 파일의 줄 지적은 확인 못 함', () => {
    const bin = 'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ';
    expect(one('img.png', 3, bin)).toEqual({ status: 'unverified', reason: 'binary' });
    expect(one('img.png', undefined, bin)).toEqual({ status: 'in_diff' });
  });

  it('따옴표로 감싼 경로(한글·공백)도 읽는다', () => {
    const quoted = [
      'diff --git "a/\\355\\225\\234 a.ts" "b/\\355\\225\\234 a.ts"',
      '--- "a/\\355\\225\\234 a.ts"',
      '+++ "b/\\355\\225\\234 a.ts"',
      '@@ -1,1 +1,2 @@',
      ' x',
      '+y',
    ].join('\n');
    expect(one('한 a.ts', 2, quoted)).toEqual({ status: 'in_diff' });
  });
});

describe('checkFindingsAddressed: 이후 diff에서 바뀌었는가', () => {
  /** 리뷰한 시점(옛 파일) 기준 src/a.ts의 20번 줄을 지우고 30번 줄 뒤에 한 줄을 끼운다. src/old.ts는 src/new.ts로 이름을 바꾸며 5번 줄을 고친다 */
  const LATER = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -19,3 +19,2 @@',
    ' c19',
    '-gone20',
    ' c21',
    '@@ -30,2 +29,3 @@',
    ' c30',
    '+ins',
    ' c31',
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 90%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -5,1 +5,1 @@',
    '-before5',
    '+after5',
  ].join('\n');
  const ok = { status: 'in_diff' } as const;
  const run = (findings: Array<{ file: string; line?: number }>, checks = findings.map(() => ok), later: string | undefined = LATER) =>
    checkFindingsAddressed(findings, checks, later);

  it('지적한 줄이 지워지거나 바뀌었으면 반영됨', () => {
    expect(run([{ file: 'src/a.ts', line: 20 }])).toEqual(['addressed']);
  });

  it('지적한 줄 바로 앞뒤에 줄을 끼운 것도 반영됨, 멀리 바뀐 것은 아님', () => {
    expect(run([{ file: 'src/a.ts', line: 30 }])).toEqual(['addressed']);
    expect(run([{ file: 'src/a.ts', line: 31 }])).toEqual(['addressed']);
    expect(run([{ file: 'src/a.ts', line: 25 }])).toEqual(['not_addressed']);
  });

  it('줄 없는 지적은 파일이 바뀌었는지만 본다', () => {
    expect(run([{ file: 'src/a.ts' }])).toEqual(['addressed']);
    expect(run([{ file: 'docs/b.md' }])).toEqual(['not_addressed']);
  });

  it('이름이 바뀐 파일은 옛 이름(리뷰한 시점의 이름)으로 찾는다', () => {
    expect(run([{ file: 'src/old.ts', line: 5 }])).toEqual(['addressed']);
    expect(run([{ file: 'src/new.ts', line: 5 }])).toEqual(['not_addressed']);
  });

  it('대조 못 한 지적, 대조 기록이 없는 지적, diff에 없던 지적, 이후 diff를 못 읽은 경우는 모름', () => {
    const f = [{ file: 'src/a.ts', line: 20 }];
    expect(run(f, [{ status: 'unverified' } as never])).toEqual(['unknown']);
    expect(run(f, [{ status: 'not_in_diff' } as never])).toEqual(['unknown']);
    expect(run(f, [undefined as never])).toEqual(['unknown']);
    expect(checkFindingsAddressed(f, [ok], undefined)).toEqual(['unknown']);
  });

  it('바이너리 파일의 줄 지적은 모름', () => {
    const later = 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ';
    expect(run([{ file: 'i.png', line: 3 }], [ok], later)).toEqual(['unknown']);
    expect(run([{ file: 'i.png' }], [ok], later)).toEqual(['addressed']);
  });

  it('처리율은 반영됨/(반영됨+안 됨)이고 모름은 분모에서 뺀다', () => {
    expect(summarizeAddressRate([{ addressed: ['addressed', 'not_addressed', 'unknown'] }, { addressed: ['addressed'] }, {}])).toEqual({
      addressed: 2,
      notAddressed: 1,
      unknown: 1,
      rate: 2 / 3,
    });
    expect(summarizeAddressRate([{ addressed: ['unknown'] }])).toEqual({ addressed: 0, notAddressed: 0, unknown: 1, rate: undefined });
    // 지적은 있는데 처리 기록이 없는 라운드는 지적마다 모름이다
    expect(summarizeAddressRate([{ findings: [1, 2] }, { findings: [1], addressed: ['addressed'] }])).toEqual({ addressed: 1, notAddressed: 0, unknown: 2, rate: 1 });
    expect(summarizeAddressRate([])).toEqual({ addressed: 0, notAddressed: 0, unknown: 0, rate: undefined });
  });
});

describe('마크다운 이스케이프와 표시 글', () => {
  it('끼워 넣는 글에서 백틱·줄바꿈·링크·멘션·이슈 번호를 무력화한다', () => {
    const text = escapeMarkdownText('a`b\n[x](http://e.com) @octo #12 <b> *x* _y_ |z| \\');
    expect(text).not.toMatch(/[\n`]/);
    expect(text).not.toContain('@octo');
    expect(text).not.toContain('#12');
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('](');
    expect(text).toContain('&#64;octo');
  });

  it('파일 이름은 안에 든 백틱보다 긴 울타리의 코드 조각으로 감싼다', () => {
    expect(inlineCodeSpan('a`b')).toBe('``a`b``');
    expect(inlineCodeSpan('a``b`')).toBe('``` a``b` ```');
    expect(inlineCodeSpan('a\nb')).toBe('`a b`');
  });

  it('diff 안이면 아무 글도 없고, 표시할 것이 있을 때만 한국어 절을 만든다', () => {
    const findings = [
      { severity: 'major' as const, file: 'src/a.ts', line: 12, title: '괜찮음', detail: 'd' },
      { severity: 'major' as const, file: 'x`y@evil.ts', line: 3, title: '제목 [링크](http://e) @octo', detail: 'd' },
      { severity: 'minor' as const, file: 'big.ts', title: '못 봄', detail: 'd' },
    ];
    const checks = [{ status: 'in_diff' }, { status: 'not_in_diff', reason: 'file_missing' }, { status: 'unverified', reason: 'file_omitted' }] as const;
    expect(buildReviewCheckNote({ findings: [findings[0]!], checks: [checks[0]] })).toBe('');
    const note = buildReviewCheckNote({ findings, checks: [...checks] });
    expect(note).toContain('diff에 없음');
    expect(note).toContain('확인 못 함');
    expect(note).not.toContain('@octo');
    expect(note).not.toContain('](http');
    expect(note).not.toContain('ADR');
    expect(note).toContain('판정');
  });

  it('이전 라운드 처리율이 있으면 한 줄로 적고, 센 것이 없으면 모른다고 적는다', () => {
    const f = { severity: 'minor' as const, file: 'a', title: 't', detail: 'd' };
    const withRate = buildReviewCheckNote({ findings: [f], checks: [{ status: 'in_diff' }], previousRounds: [{ addressed: ['addressed', 'not_addressed', 'unknown'] }] });
    expect(withRate).toContain('1/2');
    expect(withRate).toContain('모름 1');
    const none = buildReviewCheckNote({ findings: [f], checks: [{ status: 'in_diff' }], previousRounds: [{ addressed: ['unknown'] }] });
    expect(none).toContain('모름');
    expect(none).not.toContain('NaN');
  });
});
