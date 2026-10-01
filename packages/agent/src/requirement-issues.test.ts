import { describe, expect, it } from 'vitest';
import {
  ALLOWED_REQUIREMENT_ENDPOINTS,
  assertAllowedRequirementEndpoint,
  buildManagedRegion,
  buildRegionContent,
  buildRequirementIssueFormYaml,
  buildRequirementsAddendum,
  buildReviewRequirementsContext,
  buildStatusComment,
  buildSubIssueBody,
  buildTrackingIssueBody,
  draftRequirementFromIssue,
  extractRequirementMentions,
  findExistingRemoteIssue,
  findPinnedStatusComment,
  implementsTrailer,
  isStatusComment,
  parseManagedRegion,
  parseRequirementIssueForm,
  planRequirementPublish,
  requirementContentHash,
  requirementIdFromIssueTitle,
  requirementLabelSet,
  RequirementEndpointError,
  subIssueTitle,
  summarizeRequirementPlan,
  type RemoteIssueSnapshot,
  type RequirementForIssues,
  type RequirementPlanInput,
} from './requirement-issues';

function req(overrides: Partial<RequirementForIssues> = {}): RequirementForIssues {
  return { id: 'R1', title: '로그인 API', kind: 'api', priority: 'must', acceptance: ['이메일·비밀번호로 로그인한다', '실패하면 401을 준다'], ...overrides };
}

describe('managed region 왕복', () => {
  it('build 뒤 parse하면 id·rev·hash·content가 그대로 돌아온다', () => {
    const requirement = req({ ears: '사용자가 로그인을 요청하면 시스템은 토큰을 발급해야 한다', scenarios: [{ given: '유효한 자격 증명', when: '로그인 요청', then: '토큰 발급' }], nfr: ['응답 200ms 이내'] });
    const body = buildManagedRegion(requirement, 2);
    const parsed = parseManagedRegion(body);
    expect(parsed).toBeDefined();
    expect(parsed!.id).toBe('R1');
    expect(parsed!.rev).toBe(2);
    expect(parsed!.content).toBe(buildRegionContent(requirement));
    expect(parsed!.hash).toBe(requirementContentHash(requirement));
  });

  it('필드가 없으면 "(없음)"·"(정의되지 않음)"으로 채운다', () => {
    const content = buildRegionContent(req());
    expect(content).toContain('(정의되지 않음)');
    expect(content).toContain('(없음)');
    expect(content).toContain('종류: api · 우선순위: must');
  });

  it('마커가 없는 본문은 undefined를 돌려준다', () => {
    expect(parseManagedRegion('그냥 사람이 쓴 이슈입니다')).toBeUndefined();
  });

  it('하위 이슈 본문·제목을 만든다', () => {
    const requirement = req();
    expect(subIssueTitle(requirement)).toBe('[R1] 로그인 API');
    expect(requirementIdFromIssueTitle(subIssueTitle(requirement))).toBe('R1');
    expect(requirementIdFromIssueTitle('그냥 이슈 제목')).toBeUndefined();
    expect(buildSubIssueBody(requirement, 1)).toBe(buildManagedRegion(requirement, 1));
  });
});

describe('라벨 집합', () => {
  it('b-studio:req, kind, priority, status 네 개를 만든다', () => {
    expect(requirementLabelSet(req({ kind: 'ui', priority: 'should' }), '작업 중')).toEqual(['b-studio:req', 'kind:ui', 'priority:should', 'status:작업 중']);
  });
});

describe('추적 이슈 본문', () => {
  it('표에는 하위 이슈가 있는 요구사항만, 체크리스트에는 could·docs만 담는다', () => {
    const body = buildTrackingIssueBody('orders', [
      { requirement: { id: 'R1', title: '로그인', kind: 'api', priority: 'must' }, status: '검증됨', issue: 10, checklistOnly: false },
      { requirement: { id: 'R2', title: '로고 바꾸기', kind: 'ui', priority: 'could' }, status: '미착수', checklistOnly: true },
    ]);
    expect(body).toContain('| R1 | 로그인 | api | must | 검증됨 | #10 |');
    expect(body).not.toContain('| R2 |');
    expect(body).toContain('- [ ] R2. 로고 바꾸기');
  });

  it('검증된 체크리스트 항목은 체크 표시가 붙는다', () => {
    const body = buildTrackingIssueBody('orders', [{ requirement: { id: 'R3', title: 'README', kind: 'docs', priority: 'must' }, status: '검증됨', checklistOnly: true }]);
    expect(body).toContain('- [x] R3. README');
  });
});

describe('발행 계획', () => {
  function plan(inputs: RequirementPlanInput[], remote: RemoteIssueSnapshot[] = []) {
    return planRequirementPublish(inputs, remote);
  }

  it('원격에 이슈가 없으면 create(체크리스트 전용이면 그렇게 표시)', () => {
    const [entry] = plan([{ requirement: req(), status: '미착수' }]);
    expect(entry!.action).toBe('create');
    expect(entry!.checklistOnly).toBe(false);

    const [could] = plan([{ requirement: req({ priority: 'could' }), status: '미착수' }]);
    expect(could!.action).toBe('create');
    expect(could!.checklistOnly).toBe(true);
  });

  it('처음 발행하면 create, 발행 뒤 내용이 그대로면 unchanged(멱등 — 두 번 불러도 다시 만들지 않는다)', () => {
    const requirement = req();
    const hash = requirementContentHash(requirement);
    const publishedRequirement: RequirementForIssues = { ...requirement, trace: { issue: 42 }, published: { issue: 42, hash, at: '2026-01-01T00:00:00Z' } };
    const remoteIssues: RemoteIssueSnapshot[] = [{ number: 42, state: 'open', body: buildManagedRegion(requirement, 1) }];

    const firstRound = plan([{ requirement: publishedRequirement, status: '작업 중' }], remoteIssues);
    expect(firstRound[0]!.action).toBe('unchanged');
    expect(firstRound[0]!.issue).toBe(42);

    // 다시 계산해도(같은 입력) 여전히 unchanged다 — 재발행이 이슈를 중복으로 만들지 않는다
    const secondRound = plan([{ requirement: publishedRequirement, status: '작업 중' }], remoteIssues);
    expect(secondRound[0]!.action).toBe('unchanged');
  });

  it('로컬 내용이 바뀌면(마지막 발행 해시와 달라지면) update, 닫힌 이슈면 reverify', () => {
    const before = req({ acceptance: ['이메일·비밀번호로 로그인한다'] });
    const after = req({ acceptance: ['이메일·비밀번호로 로그인한다', '2단계 인증을 지원한다'] });
    const publishedHash = requirementContentHash(before);
    const tracked: RequirementForIssues = { ...after, trace: { issue: 7 }, published: { issue: 7, hash: publishedHash, at: '2026-01-01T00:00:00Z' } };

    const openRemote: RemoteIssueSnapshot[] = [{ number: 7, state: 'open', body: buildManagedRegion(before, 1) }];
    expect(plan([{ requirement: tracked, status: '작업 중' }], openRemote)[0]!.action).toBe('update');

    const closedRemote: RemoteIssueSnapshot[] = [{ number: 7, state: 'closed', body: buildManagedRegion(before, 1) }];
    expect(plan([{ requirement: tracked, status: '작업 중' }], closedRemote)[0]!.action).toBe('reverify');
  });

  it('원격 이슈 내용이 우리가 마지막으로 쓴 것과 달라지면(GitHub에서 직접 수정) conflict', () => {
    const requirement = req();
    const publishedHash = requirementContentHash(requirement);
    const tracked: RequirementForIssues = { ...requirement, trace: { issue: 5 }, published: { issue: 5, hash: publishedHash, at: '2026-01-01T00:00:00Z' } };
    // GitHub에서 사람이 본문을 직접 고쳤다(마커의 hash= 속성은 그대로 두고 눈에 보이는 내용만 바꿨다고 가정)
    const editedBody = buildManagedRegion(requirement, 1).replace('이메일·비밀번호로 로그인한다', '소셜 로그인으로 로그인한다');
    const remoteIssues: RemoteIssueSnapshot[] = [{ number: 5, state: 'open', body: editedBody }];

    const [entry] = plan([{ requirement: tracked, status: '작업 중' }], remoteIssues);
    expect(entry!.action).toBe('conflict');
    expect(entry!.remoteHash).not.toBe(publishedHash);
  });

  it('닫혀 있는데 요구사항이 검증되지 않았으면 closed_but_requirement_exists', () => {
    const requirement = req();
    const hash = requirementContentHash(requirement);
    const tracked: RequirementForIssues = { ...requirement, trace: { issue: 9 }, published: { issue: 9, hash, at: '2026-01-01T00:00:00Z' } };
    const remoteIssues: RemoteIssueSnapshot[] = [{ number: 9, state: 'closed', body: buildManagedRegion(requirement, 1) }];
    expect(plan([{ requirement: tracked, status: '작업 중' }], remoteIssues)[0]!.action).toBe('closed_but_requirement_exists');
  });

  it('trace.issue가 없어도 관리형 영역의 id 마커로 원격 이슈를 다시 찾는다', () => {
    const requirement = req();
    const remoteIssues: RemoteIssueSnapshot[] = [{ number: 99, state: 'open', body: buildManagedRegion(requirement, 1) }];
    expect(findExistingRemoteIssue(requirement, remoteIssues)?.number).toBe(99);
  });

  it('summarizeRequirementPlan이 행동별 개수를 센다', () => {
    const summary = summarizeRequirementPlan([
      { id: 'R1', action: 'create', localHash: 'a', checklistOnly: false, note: '' },
      { id: 'R2', action: 'update', localHash: 'b', checklistOnly: false, note: '' },
      { id: 'R3', action: 'unchanged', localHash: 'c', checklistOnly: false, note: '' },
    ]);
    expect(summary).toMatchObject({ total: 3, create: 1, update: 1, unchanged: 1, conflict: 0 });
  });
});

describe('상태 반영 고정 댓글', () => {
  it('표(시나리오·테스트·결과·커밋·게이트)를 만들고 id로 다시 찾을 수 있다', () => {
    const body = buildStatusComment('R1', '검증됨', [{ scenario: '유효한 자격 증명으로 로그인', test: 'it R1 로그인', result: '통과', commit: 'abc1234', gate: 'test' }]);
    expect(body).toContain('**상태: 검증됨**');
    expect(body).toContain('| 유효한 자격 증명으로 로그인 | it R1 로그인 | 통과 | abc1234 | test |');
    expect(isStatusComment(body, 'R1')).toBe(true);
    expect(isStatusComment(body, 'R2')).toBe(false);

    const found = findPinnedStatusComment([{ id: 1, body: '무관한 댓글' }, { id: 2, body }], 'R1');
    expect(found?.id).toBe(2);
  });

  it('근거가 없으면 빈 줄로 대신한다', () => {
    expect(buildStatusComment('R1', '미착수', [])).toContain('| (근거 없음) | - | - | - | - |');
  });
});

describe('PR 본문 조립', () => {
  it('검증됨 + 이슈 있는 요구사항만 Closes를, 전부 Implements를 단다', () => {
    const addendum = buildRequirementsAddendum([
      { id: 'R1', rev: 2, issue: 10, status: '검증됨' },
      { id: 'R2', issue: 11, status: '작업 중' },
    ]);
    expect(addendum).toContain('Closes #10');
    expect(addendum).not.toContain('Closes #11');
    expect(addendum).toContain('Implements: R1@rev2');
    expect(addendum).toContain('Implements: R2');
    expect(addendum).toContain('기본 브랜치로 열릴 때만');
  });

  it('요구사항이 없으면 빈 문자열', () => {
    expect(buildRequirementsAddendum([])).toBe('');
  });

  it('implementsTrailer는 rev가 있으면 @revN을 붙인다', () => {
    expect(implementsTrailer({ id: 'R4', rev: 3 })).toBe('Implements: R4@rev3');
    expect(implementsTrailer({ id: 'R4' })).toBe('Implements: R4');
  });

  it('커밋 제목에서 [R4] 형태의 언급을 순서대로, 중복 없이 뽑는다', () => {
    expect(extractRequirementMentions(['요청: [R4] 로그인', '요청: [R2] 목록', '요청: [R4] 로그인 보완'])).toEqual(['R4', 'R2']);
  });

  it('AI 리뷰 문맥에 요구사항 제목·시나리오를 압축해 담는다', () => {
    const context = buildReviewRequirementsContext([{ id: 'R1', title: '로그인', scenarios: [{ given: 'a', when: 'b', then: 'c' }] }]);
    expect(context).toContain('R1. 로그인');
    expect(context).toContain('Given a When b Then c');
  });
});

describe('이슈 가져오기', () => {
  it('요구사항 이슈 폼(구조화된 구획)을 파싱한다', () => {
    const body = ['### 제목', '', '결제 재시도', '', '### 종류', '', 'api', '', '### 우선순위', '', 'should', '', '### 인수 조건', '', '- 실패하면 3번까지 재시도한다', '- 그래도 실패하면 알림을 보낸다'].join('\n');
    const draft = parseRequirementIssueForm('[R?] 결제 재시도', body);
    expect(draft).toEqual({ title: '결제 재시도', kind: 'api', priority: 'should', acceptance: ['실패하면 3번까지 재시도한다', '그래도 실패하면 알림을 보낸다'], guessed: false });
  });

  it('폼 구획이 없으면 undefined', () => {
    expect(parseRequirementIssueForm('그냥 이슈', '아무 내용')).toBeUndefined();
  });

  it('우리가 발행한 이슈(관리형 영역)는 종류·우선순위·인수 조건을 정확히 되읽는다', () => {
    const requirement = req({ priority: 'should', acceptance: ['하나', '둘'] });
    const body = buildManagedRegion(requirement, 3);
    const draft = draftRequirementFromIssue(subIssueTitle(requirement), body);
    expect(draft).toEqual({ title: '로그인 API', kind: 'api', priority: 'should', acceptance: ['하나', '둘'], guessed: false });
  });

  it('이슈 폼으로 만든 이슈도 가져온다', () => {
    const body = ['### 종류', '', 'ui', '', '### 우선순위', '', 'must', '', '### 인수 조건', '', '- 버튼이 보인다'].join('\n');
    expect(draftRequirementFromIssue('[R?] 새 버튼', body)).toEqual({ title: '새 버튼', kind: 'ui', priority: 'must', acceptance: ['버튼이 보인다'], guessed: false });
  });

  it('평문 이슈는 글머리 기호를 인수 조건으로 보고 기본값(api·must)으로 두며 guessed를 표시한다', () => {
    const draft = draftRequirementFromIssue('버그: 목록이 안 보임', '증상:\n- 새로고침하면 빈 화면\n- 콘솔에 오류 없음');
    expect(draft).toEqual({ title: '버그: 목록이 안 보임', kind: 'api', priority: 'must', acceptance: ['새로고침하면 빈 화면', '콘솔에 오류 없음'], guessed: true });
  });

  it('이슈 폼 yaml 생성기는 필수 필드를 담는다', () => {
    const yaml = buildRequirementIssueFormYaml();
    expect(yaml).toContain('name: 요구사항');
    expect(yaml).toContain('labels: ["b-studio:req"]');
    expect(yaml).toContain('id: acceptance');
  });
});

describe('API 경로 화이트리스트', () => {
  it('이슈·하위 이슈·댓글·라벨 경로는 통과한다', () => {
    for (const path of [
      '/repos/acme/orders/issues',
      '/repos/acme/orders/issues/42',
      '/repos/acme/orders/issues/42/comments',
      '/repos/acme/orders/issues/comments/9001',
      '/repos/acme/orders/issues/42/sub_issues',
      '/repos/acme/orders/labels',
    ]) {
      expect(() => assertAllowedRequirementEndpoint(path)).not.toThrow();
    }
  });

  it('협업자·권한·설정·웹훅·브랜치 보호 경로는 절대 허용하지 않는다', () => {
    for (const path of [
      '/repos/acme/orders/collaborators/bob',
      '/repos/acme/orders/collaborators/bob/permission',
      '/repos/acme/orders',
      '/repos/acme/orders/hooks',
      '/repos/acme/orders/branches/main/protection',
      '/orgs/acme/members',
      '/user',
    ]) {
      expect(() => assertAllowedRequirementEndpoint(path)).toThrow(RequirementEndpointError);
    }
  });

  it('화이트리스트 패턴 자체가 owner/repo 밖으로 새지 않는다(슬래시가 더 있으면 거부)', () => {
    expect(ALLOWED_REQUIREMENT_ENDPOINTS.some((pattern) => pattern.test('/repos/acme/orders/issues/42/comments/extra'))).toBe(false);
  });
});
