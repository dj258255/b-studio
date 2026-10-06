import { describe, expect, it } from 'vitest';
import type { AgentUsage } from './loop';
import { AGENT_LANGUAGE_INSTRUCTION } from './prompts';
import {
  buildPrReviewComment,
  buildPrReviewExternalContext,
  buildPrReviewFixRequest,
  buildPrReviewResolvedContext,
  buildPrReviewSystemPrompt,
  buildPrReviewUserPrompt,
  buildReviewResolutionComment,
  diffFilePaths,
  extractDiffReferencedNames,
  extractPrReviewFixTitles,
  hasBlockingFindings,
  isBlockingFinding,
  MAX_PR_REVIEW_FINDINGS,
  nextPrReviewStep,
  parsePrReviewReply,
  PrReviewError,
  prReviewMarker,
  requestPrReview,
  severityCounts,
  truncateDiff,
  type PrReviewFinding,
} from './pr-review';

const usage: AgentUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

const finding = (severity: PrReviewFinding['severity'], overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
  severity,
  file: 'apps/studio/lib/server/sessions.ts',
  title: '제목',
  detail: '설명',
  ...overrides,
});

describe('parsePrReviewReply', () => {
  it('JSON 하나만 있으면 findings 배열을 돌려준다', () => {
    const text = '```json\n{"findings":[{"severity":"blocker","file":"a.ts","title":"t","detail":"d"}]}\n```';
    expect(parsePrReviewReply(text)).toEqual([{ severity: 'blocker', file: 'a.ts', title: 't', detail: 'd' }]);
  });

  it('지적이 없으면 빈 배열도 받아들인다', () => {
    expect(parsePrReviewReply('{"findings":[]}')).toEqual([]);
  });

  it('JSON을 찾지 못하면 PrReviewError를 던진다', () => {
    expect(() => parsePrReviewReply('그냥 문장입니다')).toThrow(PrReviewError);
  });

  it('스키마에 안 맞으면(잘못된 severity, 필수 필드 없음) PrReviewError를 던진다', () => {
    expect(() => parsePrReviewReply('{"findings":[{"severity":"urgent","file":"a.ts","title":"t","detail":"d"}]}')).toThrow(/리뷰 응답 형식/);
    expect(() => parsePrReviewReply('{"findings":[{"severity":"blocker","file":"a.ts"}]}')).toThrow(PrReviewError);
  });

  it('findings가 상한을 넘으면 거부한다', () => {
    const many = Array.from({ length: MAX_PR_REVIEW_FINDINGS + 1 }, (_, index) => ({ severity: 'nit', file: `f${index}.ts`, title: 't', detail: 'd' }));
    expect(() => parsePrReviewReply(JSON.stringify({ findings: many }))).toThrow(PrReviewError);
  });
});

describe('hasBlockingFindings · nextPrReviewStep', () => {
  it('차단·주요만 막는 것으로 본다', () => {
    expect(hasBlockingFindings([finding('minor'), finding('nit')])).toBe(false);
    expect(hasBlockingFindings([finding('major')])).toBe(true);
    expect(hasBlockingFindings([finding('blocker')])).toBe(true);
  });

  it('막는 지적이 없으면 라운드와 관계없이 통과한다', () => {
    expect(nextPrReviewStep([], 1, 2)).toBe('pass');
    expect(nextPrReviewStep([finding('minor')], 2, 2)).toBe('pass');
  });

  it('막는 지적이 있고 라운드가 남았으면 고치러 보낸다', () => {
    expect(nextPrReviewStep([finding('blocker')], 1, 2)).toBe('fix');
  });

  it('막는 지적이 있어도 상한에 이르면 사람에게 넘긴다', () => {
    expect(nextPrReviewStep([finding('major')], 2, 2)).toBe('cap');
    expect(nextPrReviewStep([finding('major')], 3, 2)).toBe('cap');
  });

  it('isBlockingFinding은 심각도 하나만 보고 차단·주요를 가린다(사람이 지적 하나를 오탐으로 닫을 때도 같은 기준, 과제 67-b)', () => {
    expect(isBlockingFinding({ severity: 'blocker' })).toBe(true);
    expect(isBlockingFinding({ severity: 'major' })).toBe(true);
    expect(isBlockingFinding({ severity: 'minor' })).toBe(false);
    expect(isBlockingFinding({ severity: 'nit' })).toBe(false);
  });
});

describe('severityCounts', () => {
  it('심각도별로 센다', () => {
    expect(severityCounts([finding('blocker'), finding('blocker'), finding('nit')])).toEqual({ blocker: 2, major: 0, minor: 0, nit: 1 });
  });
});

describe('truncateDiff', () => {
  it('상한 안이면 그대로 둔다', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n+hello\n';
    expect(truncateDiff(diff, 1_000)).toEqual({ diff, truncated: false, omittedFiles: [] });
  });

  it('상한을 넘으면 가장 큰 파일부터 생략하고, 작은 파일은 그대로 남긴다', () => {
    const big = `diff --git a/big.ts b/big.ts\n${'+line\n'.repeat(2_000)}`;
    const small = 'diff --git a/small.ts b/small.ts\n+tiny change\n';
    const diff = `${big}${small}`;
    const result = truncateDiff(diff, 500);
    expect(result.truncated).toBe(true);
    expect(result.omittedFiles).toEqual(['big.ts']);
    expect(result.diff).toContain('small.ts');
    expect(result.diff).toContain('+tiny change');
    expect(result.diff).not.toContain('+line');
    expect(result.diff).toContain('생략했습니다');
  });

  it("'diff --git' 구분이 없는 입력은 통째로 잘라 노트를 붙인다", () => {
    const result = truncateDiff('x'.repeat(1_000), 100);
    expect(result.truncated).toBe(true);
    expect(result.diff.startsWith('x'.repeat(100))).toBe(true);
    expect(result.diff).toContain('생략했습니다');
  });

  it('여러 파일이 커도 상한 아래로 줄어들 때까지 큰 파일부터 계속 생략한다', () => {
    const fileOf = (name: string, lines: number) => `diff --git a/${name} b/${name}\n${'+x\n'.repeat(lines)}`;
    const diff = [fileOf('a.ts', 500), fileOf('b.ts', 400), fileOf('c.ts', 10)].join('');
    const result = truncateDiff(diff, 200);
    expect(result.omittedFiles).toEqual(['a.ts', 'b.ts']);
    expect(result.diff).toContain('c.ts');
    expect(result.diff.length).toBeLessThan(diff.length);
  });
});

describe('buildPrReviewSystemPrompt', () => {
  it('모델 계열과 관계없이 지적을 한국어로 쓰라고 못박는다(과제 65: 1라운드 한국어, 2라운드 영어로 섞이던 버그)', () => {
    const prompt = buildPrReviewSystemPrompt();
    expect(prompt).toContain(AGENT_LANGUAGE_INSTRUCTION);
    expect(prompt).toContain('Korean');
  });
});

describe('diffFilePaths · extractDiffReferencedNames', () => {
  it('diffFilePaths는 diff에 실제로 들어 있는 파일 경로만 모은다', () => {
    const diff = 'diff --git a/a/Seed.java b/a/Seed.java\n+x\ndiff --git a/b.ts b/b.ts\n+y\n';
    expect(diffFilePaths(diff)).toEqual(['a/Seed.java', 'b.ts']);
  });

  it('추가된 줄의 상대 경로 import에서 파일 이름을 뽑는다(지운 줄은 보지 않는다)', () => {
    const diff = "diff --git a/a.ts b/a.ts\n+import { SeedLoader } from './seed-loader';\n-import { OldLoader } from './old-loader';\n";
    const names = extractDiffReferencedNames(diff);
    expect(names).toContain('seed-loader');
    expect(names).not.toContain('old-loader');
  });

  it('Java import문의 마지막 이름을 뽑는다', () => {
    const diff = 'diff --git a/A.java b/A.java\n+import com.example.seed.SeedLoader;\n';
    expect(extractDiffReferencedNames(diff)).toContain('SeedLoader');
  });

  it('파스칼 케이스 식별자를 클래스 이름 후보로 뽑고, 전부 대문자인 약어는 뺀다', () => {
    const diff = 'diff --git a/A.java b/A.java\n+        seedLoader.load(SQL_PATH); // SeedLoader가 시퀀스를 복원한다\n';
    const names = extractDiffReferencedNames(diff);
    expect(names).toContain('SeedLoader');
    expect(names).not.toContain('SQL_PATH'); // 전부 대문자(약어)는 뺀다
  });
});

describe('buildPrReviewExternalContext', () => {
  it('파일이 없으면 빈 문자열', () => {
    expect(buildPrReviewExternalContext([])).toBe('');
  });

  it('파일 미리보기를 묶고, 상한을 넘으면 앞에서부터만 담는다', () => {
    const context = buildPrReviewExternalContext([{ path: 'api/SeedLoader.java', excerpt: 'class SeedLoader { ALTER TABLE ... RESTART WITH }' }]);
    expect(context).toContain('diff 밖 참고 파일');
    expect(context).toContain('api/SeedLoader.java');
    expect(context).toContain('RESTART WITH');

    const big = buildPrReviewExternalContext(
      [
        { path: 'a.java', excerpt: 'x'.repeat(50) },
        { path: 'b.java', excerpt: 'y'.repeat(50) },
      ],
      80,
    );
    expect(big).not.toContain('b.java');
  });
});

describe('buildPrReviewResolvedContext · buildReviewResolutionComment', () => {
  it('빈 목록이면 빈 문자열', () => {
    expect(buildPrReviewResolvedContext([])).toBe('');
  });

  it('사람이 오탐으로 닫은 지적을 "이미 확인했다"는 섹션으로 만든다', () => {
    const context = buildPrReviewResolvedContext([{ severity: 'blocker', file: 'api/Seed.java', line: 10, title: '시퀀스 미복원', reason: '실제 PostgreSQL에서 새 글 id 43·44 확인' }]);
    expect(context).toContain('이미 사람이 확인한 지적');
    expect(context).toContain('api/Seed.java:10');
    expect(context).toContain('시퀀스 미복원');
    expect(context).toContain('새 글 id 43·44 확인');
  });

  it('오탐 닫기 댓글은 지적 위치·제목·이유를 담는다', () => {
    const comment = buildReviewResolutionComment(finding('blocker', { title: '시퀀스 미복원', line: 10 }), '실제 PostgreSQL에서 새 글 id 43·44 확인');
    expect(comment).toContain('사람이 리뷰 지적을 확인했습니다');
    expect(comment).toContain('시퀀스 미복원');
    expect(comment).toContain('새 글 id 43·44 확인');
  });
});

describe('extractPrReviewFixTitles', () => {
  it('AI 리뷰 고침 요청이 아니면 undefined', () => {
    expect(extractPrReviewFixTitles('대시보드 로딩 버그를 고쳐 주세요')).toBeUndefined();
  });

  it('AI 리뷰 고침 요청이면 굵게 감싼 지적 제목들을 순서대로 뽑는다', () => {
    const request = buildPrReviewFixRequest([finding('blocker', { title: '시드 id 시퀀스 검증' }), finding('major', { title: '마이그레이션 테스트' })]);
    expect(extractPrReviewFixTitles(request)).toEqual(['시드 id 시퀀스 검증', '마이그레이션 테스트']);
  });
});

describe('buildPrReviewComment · prReviewMarker', () => {
  it('지적이 없으면 통과 문구와 라운드별 숨은 표시를 담는다', () => {
    const comment = buildPrReviewComment({ round: 1, maxRounds: 2, findings: [], outcome: 'pass' });
    expect(comment).toContain('지적할 내용이 없습니다');
    expect(comment).toContain('사람 검토를 기다립니다');
    expect(comment).toContain(prReviewMarker(1));
    expect(prReviewMarker(1)).toBe('<!-- b-studio-review round=1 -->');
  });

  it('지적이 있으면 한국어 표로 심각도·위치·제목·설명을 담고, 표 구분 문자를 이스케이프한다', () => {
    const comment = buildPrReviewComment({
      round: 1,
      maxRounds: 2,
      findings: [finding('blocker', { line: 12, detail: 'a | b' }), finding('minor')],
      outcome: 'fix',
    });
    expect(comment).toContain('차단 1 · 주요 0 · 경미 1 · 사소 0');
    expect(comment).toContain('apps/studio/lib/server/sessions.ts:12');
    expect(comment).toContain('a \\| b');
    expect(comment).toContain('고치도록 세션에 요청');
  });

  it('상한에 걸리면 사람에게 넘긴다는 문구를 담는다', () => {
    const comment = buildPrReviewComment({ round: 2, maxRounds: 2, findings: [finding('major')], outcome: 'cap' });
    expect(comment).toContain('라운드 상한(2)');
  });

  it('생략한 파일이 있으면 참고 문구를 남긴다', () => {
    const comment = buildPrReviewComment({ round: 1, maxRounds: 2, findings: [], outcome: 'pass', omittedFiles: ['big.ts'] });
    expect(comment).toContain('big.ts');
  });

  it('since가 있는 커밋 범위를 주면 어느 커밋부터 어느 커밋까지 봤는지 적는다(버그 리포트 86)', () => {
    const comment = buildPrReviewComment({
      round: 2,
      maxRounds: 3,
      findings: [],
      outcome: 'pass',
      commitRange: { since: '5d463761234567890abcdef', head: '8682b77abcdef1234567890' },
    });
    expect(comment).toContain('커밋 범위: `5d46376`..`8682b77`');
  });

  it('since 없이 head만 있으면(세션 시작부터 보는 첫 리뷰) 커밋 범위를 적지 않는다', () => {
    const comment = buildPrReviewComment({ round: 1, maxRounds: 2, findings: [], outcome: 'pass', commitRange: { head: '8682b77abcdef1234567890' } });
    expect(comment).not.toContain('커밋 범위');
  });
});

describe('buildPrReviewFixRequest', () => {
  it('차단·주요만 골라 고치라는 요청 문구를 만든다(경미·사소는 뺀다)', () => {
    const request = buildPrReviewFixRequest([finding('blocker', { title: 'A' }), finding('minor', { title: 'B' }), finding('major', { title: 'C', suggestion: '이렇게 고치세요' })]);
    expect(request).toContain('A');
    expect(request).not.toContain('B');
    expect(request).toContain('C');
    expect(request).toContain('이렇게 고치세요');
    expect(request).toContain('관련 없는 다른 변경은 하지 마세요');
  });
});

describe('buildPrReviewUserPrompt', () => {
  it('requirementsContext를 주면 diff 앞에 끼워 넣고, 없으면 그대로 둔다(ADR-092)', () => {
    const withContext = buildPrReviewUserPrompt({ diff: 'd', requests: ['요청1'], round: 1, requirementsContext: '[이 PR이 구현하는 요구사항]\n- R1. 로그인' });
    expect(withContext).toContain('[이 PR이 구현하는 요구사항]');
    expect(withContext).toContain('- R1. 로그인');

    const withoutContext = buildPrReviewUserPrompt({ diff: 'd', requests: ['요청1'], round: 1 });
    expect(withoutContext).not.toContain('요구사항');

    const blank = buildPrReviewUserPrompt({ diff: 'd', requests: ['요청1'], round: 1, requirementsContext: '   ' });
    expect(blank).not.toContain('요구사항');
  });

  it('externalContext·resolvedContext를 주면 그대로 싣고, 없으면 그대로 둔다(과제 67)', () => {
    const withBoth = buildPrReviewUserPrompt({
      diff: 'd',
      requests: ['요청1'],
      round: 1,
      externalContext: '[diff 밖 참고 파일]\nSeedLoader',
      resolvedContext: '[이미 사람이 확인한 지적]\n시퀀스 미복원',
    });
    expect(withBoth).toContain('SeedLoader');
    expect(withBoth).toContain('시퀀스 미복원');

    const withoutBoth = buildPrReviewUserPrompt({ diff: 'd', requests: ['요청1'], round: 1 });
    expect(withoutBoth).not.toContain('참고 파일');
    expect(withoutBoth).not.toContain('이미 사람이 확인한');
  });
});

describe('requestPrReview', () => {
  it('ask를 불러 findings·usage·durationMs를 돌려준다', async () => {
    const ask = async () => ({ text: '{"findings":[{"severity":"nit","file":"a.ts","title":"t","detail":"d"}]}', usage });
    const result = await requestPrReview(ask, { diff: 'diff --git a/a.ts b/a.ts\n', requests: ['요청1'], round: 1 });
    expect(result.findings).toEqual([{ severity: 'nit', file: 'a.ts', title: 't', detail: 'd' }]);
    expect(result.usage).toEqual(usage);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('응답 형식이 틀리면 그때까지 쓴 토큰·시간을 오류에 남겨 다시 던진다', async () => {
    const ask = async () => ({ text: '문장만 있음', usage });
    await expect(requestPrReview(ask, { diff: 'd', requests: [], round: 1 })).rejects.toMatchObject({ usage, durationMs: expect.any(Number) });
  });
});
