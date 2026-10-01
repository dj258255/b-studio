import { describe, expect, it } from 'vitest';
import {
  adrFilePath,
  appendRoadmapTradeoffEntry,
  appendTroubleshootingEntry,
  buildAdrTemplate,
  buildDesignDocTemplate,
  buildDocSummary,
  buildRoadmapTradeoffEntry,
  buildTroubleshootingEntry,
  designDocFilePath,
  DOCS_INDEX_END,
  DOCS_INDEX_START,
  extractDocSummary,
  nextAdrNumber,
  nextDesignDocNumber,
  regenerateDocsReadme,
  slugifyTitle,
} from './docs';

describe('slugifyTitle', () => {
  it('공백은 하이픈으로, 한글은 그대로 둔다(BE-commerce 관례)', () => {
    expect(slugifyTitle('결제 도메인 핵심 개념')).toBe('결제-도메인-핵심-개념');
  });

  it('파일 이름에 쓸 수 없는 문자는 지운다', () => {
    expect(slugifyTitle('질문: "이게 맞나?" / 확인')).toBe('질문-이게-맞나-확인');
  });

  it('빈 제목이면 안전한 기본값을 쓴다', () => {
    expect(slugifyTitle('   ')).toBe('제목-없음');
  });
});

describe('nextDesignDocNumber / nextAdrNumber', () => {
  it('문서가 없으면 1부터 시작한다', () => {
    expect(nextDesignDocNumber([])).toBe(1);
    expect(nextAdrNumber([])).toBe(1);
  });

  it('기존 번호 중 가장 큰 값 다음 번호를 돌려준다', () => {
    expect(nextDesignDocNumber(['docs/02-결제도메인.md', 'docs/09-ERD-설계.md', 'docs/adr/ADR-010-slug.md'])).toBe(10);
    expect(nextAdrNumber(['docs/adr/ADR-001-a.md', 'docs/adr/ADR-010-b.md', 'docs/09-not-adr.md'])).toBe(11);
  });

  it('두 자리보다 큰 번호도 올바로 비교한다(숫자 비교, 문자열 비교가 아니다)', () => {
    expect(nextDesignDocNumber(['docs/09-a.md', 'docs/10-b.md'])).toBe(11);
  });
});

describe('designDocFilePath / adrFilePath', () => {
  it('두 자리로 채운 번호와 슬러그로 경로를 만든다', () => {
    expect(designDocFilePath(2, '결제 도메인 핵심 개념')).toBe('docs/02-결제-도메인-핵심-개념.md');
    expect(designDocFilePath(100, '긴 번호')).toBe('docs/100-긴-번호.md');
  });

  it('ADR 경로는 세 자리 이상으로 채운다', () => {
    expect(adrFilePath(1, '슬러그')).toBe('docs/adr/ADR-001-슬러그.md');
    expect(adrFilePath(90, '요구사항 정밀화')).toBe('docs/adr/ADR-090-요구사항-정밀화.md');
    expect(adrFilePath(123, '세 자리 넘음')).toBe('docs/adr/ADR-123-세-자리-넘음.md');
  });
});

describe('템플릿', () => {
  it('설계 문서 템플릿은 번호 매긴 H1과 맥락/결정/검토한 선택지/감수한 트레이드오프 절을 담는다', () => {
    const doc = buildDesignDocTemplate(2, '결제 도메인 핵심 개념');
    expect(doc).toContain('# 02. 결제 도메인 핵심 개념');
    expect(doc).toContain('## 맥락');
    expect(doc).toContain('## 결정');
    expect(doc).toContain('## 검토한 선택지');
    expect(doc).toContain('## 감수한 트레이드오프');
  });

  it('ADR 템플릿은 상태·날짜·관련 머리말 불릿을 먼저 둔다', () => {
    const adr = buildAdrTemplate(1, '아키텍처 결정', { date: new Date('2026-09-15T00:00:00Z'), related: ['[README](../README.md)'] });
    expect(adr).toContain('# ADR-001. 아키텍처 결정');
    expect(adr).toContain('- 상태: 제안 (Proposed)');
    expect(adr).toContain('- 날짜: 2026-09-15');
    expect(adr).toContain('- 관련: [README](../README.md)');
    expect(adr.indexOf('- 상태:')).toBeLessThan(adr.indexOf('## 맥락'));
  });

  it('트러블슈팅 항목은 증상·원인·해결 세 줄을 담고, 비어 있으면 안내 문구로 채운다', () => {
    const entry = buildTroubleshootingEntry('웹훅이 두 번 온다', { symptom: '같은 결제가 두 번 기록됨', cause: '재전송', fix: '멱등키로 막음' });
    expect(entry).toContain('### 웹훅이 두 번 온다');
    expect(entry).toContain('- 증상: 같은 결제가 두 번 기록됨');
    expect(entry).toContain('- 원인: 재전송');
    expect(entry).toContain('- 해결: 멱등키로 막음');

    const empty = buildTroubleshootingEntry('빈 항목');
    expect(empty).toContain('(무엇이 어떻게 잘못됐는지 적습니다)');
  });

  it('appendTroubleshootingEntry는 파일이 없으면 제목부터 만들고, 있으면 끝에 이어 붙인다', () => {
    const entry = buildTroubleshootingEntry('문제 A');
    const created = appendTroubleshootingEntry(undefined, entry);
    expect(created).toContain('# 트러블슈팅 기록');
    expect(created).toContain('### 문제 A');

    const appended = appendTroubleshootingEntry('# 트러블슈팅 기록\n\n### 기존 항목\n', buildTroubleshootingEntry('문제 B'));
    expect(appended).toContain('### 기존 항목');
    expect(appended).toContain('### 문제 B');
    expect(appended.indexOf('### 기존 항목')).toBeLessThan(appended.indexOf('### 문제 B'));
  });

  it('로드맵 트레이드오프 항목도 같은 이어 붙이기 규칙을 따른다', () => {
    const entry = buildRoadmapTradeoffEntry('캐시 압축 켜기', { option: '임계값 낮추기', tradeoff: 'CPU 비용 증가' });
    expect(entry).toContain('### 캐시 압축 켜기');
    expect(entry).toContain('- 후보: 임계값 낮추기');
    expect(entry).toContain('- 트레이드오프: CPU 비용 증가');
    const created = appendRoadmapTradeoffEntry(undefined, entry);
    expect(created).toContain('# 트레이드오프 후보 로드맵');
    expect(created).toContain('### 캐시 압축 켜기');
  });
});

describe('extractDocSummary', () => {
  it('첫 H1과 그 뒤 첫 문단을 뽑는다', () => {
    const md = `# 02. 결제 도메인 핵심 개념\n\n이 문서는 결제 승인·취소·정산의 기본 용어를 정리합니다.\n여러 줄도 한 문단으로 합친다.\n\n## 다음 절\n\n딴 내용`;
    const { title, paragraph } = extractDocSummary(md);
    expect(title).toBe('02. 결제 도메인 핵심 개념');
    expect(paragraph).toBe('이 문서는 결제 승인·취소·정산의 기본 용어를 정리합니다. 여러 줄도 한 문단으로 합친다.');
  });

  it('H1이 없으면 빈 제목을 돌려준다(호출하는 쪽이 파일 이름으로 메운다)', () => {
    expect(extractDocSummary('그냥 글').title).toBe('');
  });

  it('제목 바로 뒤가 표·목록·주석이면 문단으로 보지 않는다', () => {
    expect(extractDocSummary('# 제목\n\n| a | b |\n| - | - |').paragraph).toBe('');
    expect(extractDocSummary('# 제목\n\n- 목록\n- 항목').paragraph).toBe('');
    expect(extractDocSummary('# 제목\n\n<!-- 주석 -->').paragraph).toBe('');
  });
});

describe('buildDocSummary', () => {
  it('제목이 없으면 파일 이름(확장자 제외)을 제목으로 쓴다', () => {
    expect(buildDocSummary('docs/TROUBLESHOOTING-LOG.md', '그냥 글').title).toBe('TROUBLESHOOTING-LOG');
  });
});

describe('regenerateDocsReadme', () => {
  const docs = [
    { path: 'docs/02-결제도메인.md', title: '02. 결제 도메인', paragraph: '결제 용어 정리' },
    { path: 'docs/adr/ADR-001-slug.md', title: 'ADR-001. 제목', paragraph: 'ADR 요약' },
  ];

  it('README가 없으면(undefined) 머리말과 관리 구간만 담은 새 문서를 만든다', () => {
    const readme = regenerateDocsReadme(undefined, docs);
    expect(readme).toContain('# 문서');
    expect(readme).toContain(DOCS_INDEX_START);
    expect(readme).toContain(DOCS_INDEX_END);
    expect(readme).toContain('02-결제도메인.md');
    expect(readme).toContain('adr/ADR-001-slug.md');
  });

  it('관리 구간 밖의 손으로 쓴 글은 그대로 두고, 구간 안만 다시 만든다', () => {
    const existing = `# 문서\n\n사람이 쓴 안내문입니다.\n\n${DOCS_INDEX_START}\n옛 표\n${DOCS_INDEX_END}\n\n사람이 쓴 꼬리말입니다.\n`;
    const next = regenerateDocsReadme(existing, docs);
    expect(next).toContain('사람이 쓴 안내문입니다.');
    expect(next).toContain('사람이 쓴 꼬리말입니다.');
    expect(next).not.toContain('옛 표');
    expect(next).toContain('02-결제도메인.md');
  });

  it('관리 구간 표지가 아직 없으면(처음 갱신) 글 끝에 구간을 새로 덧붙인다', () => {
    const existing = '# 문서\n\n사람이 손으로 쓴 전체 안내\n';
    const next = regenerateDocsReadme(existing, docs);
    expect(next).toContain('사람이 손으로 쓴 전체 안내');
    expect(next).toContain(DOCS_INDEX_START);
    expect(next).toContain('02-결제도메인.md');
  });

  it('문서가 없으면 안내 문구를 보여 준다', () => {
    const next = regenerateDocsReadme(undefined, []);
    expect(next).toContain('아직 문서가 없습니다');
  });

  it('번호 매긴 설계 문서 → ADR → 트러블슈팅/로드맵 → 그 밖 순서로 표를 만든다', () => {
    const mixed = [
      { path: 'docs/ROADMAP-TRADEOFFS.md', title: '로드맵', paragraph: '' },
      { path: 'docs/adr/ADR-002-b.md', title: 'ADR-002', paragraph: '' },
      { path: 'docs/01-a.md', title: '01. a', paragraph: '' },
      { path: 'docs/TROUBLESHOOTING-LOG.md', title: '트러블슈팅', paragraph: '' },
      { path: 'docs/adr/ADR-001-a.md', title: 'ADR-001', paragraph: '' },
    ];
    const readme = regenerateDocsReadme(undefined, mixed);
    const order = ['01-a.md', 'ADR-001-a.md', 'ADR-002-b.md', 'TROUBLESHOOTING-LOG.md', 'ROADMAP-TRADEOFFS.md'].map((needle) => readme.indexOf(needle));
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]!);
  });
});
