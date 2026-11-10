import type { WorkflowStage } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { SessionCommit } from './checkpoints';
import { summarize } from './commit-message';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import * as current from './repository';
import type { CheckStatus, GitHostKind, IndividualReviewState, RemoteLocation, TaskListItem, TaskListProgress } from './repository';
import { isDocCheckpointPath, VERIFICATION_STAGES } from './workflow';

/**
 * 저장소 연동의 순수 판정(repository.ts)을 Rust로 옮기면서(ADR-191 3단계 3n) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을
 * 옛 구현과 새 껍데기에 넣어 결과를 JSON 글자(키 순서·NaN·-0 포함)로 견준다. `legacy`는 옮기기 전 repository.ts의 본문이다(`export`만 뗐다).
 * 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 호스트 종류·토큰 사용 여부·관리 구간 판정이 열린 쪽(other를 github로, 토큰 없음을 있음으로, 좁혀진 본문을 괜찮다고)으로 뒤집힌 수는 따로 센다. 0이어야 한다.
 *
 * 의도한 차이(입력에서 비켜 간다): 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(옛 결과도 같게 맞춘다), 옛 encodeRef의 encodeURIComponent는
 * 짝 없는 서로게이트에서 던졌으나 새 구현은 던지지 않는다(비교 주소 입력에서 뺀다).
 *
 * 크기는 환경 변수로 바꾼다: REPO_DIFF_SEEDS(쉼표 목록), REPO_DIFF_ITERATIONS, REPO_DIFF_REPORT=1(분포 출력)
 */

const legacy = (() => {
type Env = Record<string, string | undefined>;
/** 파일 하나의 patch 글자 수 한도 */
const MAX_FILE_PATCH_CHARS = 20_000;
/** PR 전체 patch 글자 수 한도. 이 한도를 넘으면 그 뒤 파일은 patch를 아예 빼고 truncated만 남긴다 */
const MAX_TOTAL_PATCH_CHARS = 200_000;

const PROVIDERS = ['github', 'gitlab', 'gitea'] as const;
const TOKEN_ENV: Record<(typeof PROVIDERS)[number], string> = {
  github: 'B_STUDIO_GITHUB_TOKEN',
  gitlab: 'B_STUDIO_GITLAB_TOKEN',
  gitea: 'B_STUDIO_GITEA_TOKEN',
};

/** GitHub PR 본문 한도(65,536자)보다 여유 있게 자른다 */
const MAX_PULL_REQUEST_BODY = 60_000;

/**
 * git 원격 주소를 해석한다. https, ssh://, scp 형식(git@host:owner/repo), 로컬 경로를 지원한다.
 * 사내 호스트는 이름만으로 종류를 알 수 없으므로 B_STUDIO_GIT_PROVIDER로 정한다.
 */
function parseRemote(url: string, env: Env = process.env): RemoteLocation {
  const trimmed = url.trim();
  let host: string;
  let repoPath: string;
  let scheme = 'https';

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'file:') return { kind: 'local', display: decodeURIComponent(parsed.pathname) };
    // ssh 포트는 웹 주소의 포트가 아니다
    host = parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : parsed.hostname;
    repoPath = decodeURIComponent(parsed.pathname);
    if (parsed.protocol === 'http:') scheme = 'http';
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
    // "C:\repo" 같은 윈도우 경로는 한 글자 호스트처럼 보인다
    if (!scp || scp[1]!.length === 1) return { kind: 'local', display: trimmed };
    host = scp[1]!;
    repoPath = scp[2]!;
  }

  const cleanPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  const hostname = host.replace(/:\d+$/, '');
  const override = PROVIDERS.find((provider) => provider === env.B_STUDIO_GIT_PROVIDER);
  const kind: GitHostKind = override ?? (hostname === 'github.com' ? 'github' : hostname === 'gitlab.com' ? 'gitlab' : 'other');
  return { kind, display: `${host}/${cleanPath}`, host, path: cleanPath, webUrl: `${scheme}://${host}/${cleanPath}` };
}

/** 토큰이 없어도 사람이 직접 PR을 만들 수 있게 작성 페이지 주소를 만든다 */
function compareUrl(remote: RemoteLocation, base: string, branch: string): string | undefined {
  if (!remote.webUrl) return undefined;
  switch (remote.kind) {
    case 'github':
      return `${remote.webUrl}/compare/${encodeRef(base)}...${encodeRef(branch)}?expand=1`;
    case 'gitea':
      return `${remote.webUrl}/compare/${encodeRef(base)}...${encodeRef(branch)}`;
    case 'gitlab':
      return `${remote.webUrl}/-/merge_requests/new?${new URLSearchParams({
        'merge_request[source_branch]': branch,
        'merge_request[target_branch]': base,
      })}`;
    default:
      return undefined;
  }
}

/**
 * `token`을 주면(개인 PC 모드의 gh CLI 토큰 등, 이슈 발행·목록 조회와 같은 경계) 환경 변수보다 그것을 앞세운다.
 * 주지 않으면 환경 변수만 본다(사내 서버 등 gh CLI를 쓰지 않는 경계에서는 호출하는 쪽이 token을 생략한다)
 */
function canCreatePullRequest(remote: RemoteLocation, env: Env = process.env, token?: string): boolean {
  return remote.kind !== 'other' && remote.kind !== 'local' && Boolean(token ?? env[TOKEN_ENV[remote.kind]]);
}

/** PR/MR 주소에서 번호를 뽑는다(github.com/o/r/pull/N, gitea .../pulls/N, gitlab .../-/merge_requests/N). 못 찾으면 undefined */
function parsePullRequestNumber(url: string): number | undefined {
  const match = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : undefined;
}

const TASK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;

/** 이슈·PR 본문에서 "- [ ] 할 일"·"- [x] 한 일" 체크리스트를 뽑는다. 들여쓴 하위 항목도 하나로 센다(중첩 진행도는 화면에서 필요치 않다) */
function parseTaskList(body: string | undefined): TaskListProgress {
  const items: TaskListItem[] = [];
  for (const line of (body ?? '').split('\n')) {
    const match = TASK_ITEM.exec(line);
    if (!match) continue;
    items.push({ checked: match[1]!.toLowerCase() === 'x', text: match[2]!.trim() });
  }
  return { total: items.length, checked: items.filter((item) => item.checked).length, items };
}

const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

/** "Closes #12", "fixes #7" 같은 닫기 문구에서 참조한 이슈·PR 번호를 뽑는다(중복 없이, 나온 순서대로) */
function parseClosingReferences(text: string | undefined): number[] {
  const numbers: number[] = [];
  for (const match of (text ?? '').matchAll(CLOSING_REFERENCE)) {
    const number = Number(match[1]);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

/** GitHub·Gitea 리뷰 상태 문구를 화면이 쓰는 값으로 바꾼다. 둘 다 대문자 스네이크 케이스를 쓴다 */
function mapReviewState(raw: string): IndividualReviewState {
  switch (raw.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
    case 'REQUEST_CHANGES':
      return 'changes_requested';
    case 'COMMENTED':
    case 'COMMENT':
      return 'commented';
    case 'DISMISSED':
      return 'dismissed';
    case 'PENDING':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** patch를 파일·전체 한도에 맞춰 자른다. runningTotal은 지금까지 쓴 글자 수(호출부가 누적해 넘긴다) */
function capPatch(patch: string | undefined, runningTotal: number): { patch?: string; truncated: boolean } {
  if (patch === undefined) return { truncated: false };
  if (runningTotal >= MAX_TOTAL_PATCH_CHARS) return { truncated: true };
  const budget = Math.min(MAX_FILE_PATCH_CHARS, MAX_TOTAL_PATCH_CHARS - runningTotal);
  if (patch.length <= budget) return { patch, truncated: false };
  return { patch: `${patch.slice(0, budget)}\n\n(patch가 길어 뒷부분을 생략했습니다)`, truncated: true };
}

/** 체크가 하나라도 안 끝났으면 pending, 끝났는데 실패·취소·조치 필요가 있으면 failure, 아니면 success */
function combineCheckStatus(runs: Array<{ status: string; conclusion: string | null }>): CheckStatus {
  if (runs.length === 0) return 'unknown';
  if (runs.some((run) => run.status !== 'completed')) return 'pending';
  const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);
  if (runs.some((run) => run.conclusion && FAILING.has(run.conclusion))) return 'failure';
  return 'success';
}

const PR_MANAGED_BODY_BEGIN = '<!-- b-studio:begin -->';
const PR_MANAGED_BODY_END = '<!-- b-studio:end -->';

/** 한도를 넘는 본문의 끝을 줄였을 때 붙이는 안내. 이 문구로 끝나는 본문은 b-studio가 줄인 것이다 */
const TRUNCATED_BODY_NOTICE = '(본문이 길어 뒷부분을 생략했습니다)';
/** 관리 영역을 감싸는 마커 둘과 줄바꿈의 길이 */
const MANAGED_MARKER_CHARS = PR_MANAGED_BODY_BEGIN.length + PR_MANAGED_BODY_END.length + 2;
/** 사람이 쓴 글이 한도를 거의 다 채웠을 때, 이보다 작은 자리에는 관리 영역을 넣지 않는다 */
const MIN_MANAGED_BODY_CHARS = 2_000;

/**
 * buildPullRequest가 만든 옛 본문(마커를 넣기 전)의 신호. 두 절 제목은 buildPullRequest가 내용과 무관하게 항상 넣는다.
 * 한도에서 끝이 잘린 본문은 뒤쪽 절("## 검증")이 없으므로, 앞쪽 절과 줄였다는 안내로 알아본다(이슈 #663 —
 * 잘린 본문을 사람이 쓴 것으로 보고 새 영역을 그 뒤에 붙였고, 합친 것이 다시 잘려 새 영역이 통째로 사라졌다)
 */
function looksLikeLegacyManagedPullRequestBody(body: string): boolean {
  if (!body.includes('## 요청')) return false;
  return body.includes('## 검증') || body.trimEnd().endsWith(TRUNCATED_BODY_NOTICE);
}

/** 마커 밖의 글(before·after)을 지키면서 관리 영역을 한도 안에 넣는다. 넘치면 관리 영역의 끝만 줄이고 닫는 마커는 남긴다 */
function wrapManagedBody(before: string, managedBody: string, after: string): string {
  const room = MAX_PULL_REQUEST_BODY - before.length - after.length - MANAGED_MARKER_CHARS;
  const managed = managedBody.length <= room ? managedBody : `${managedBody.slice(0, Math.max(0, room - TRUNCATED_BODY_NOTICE.length - 2))}\n\n${TRUNCATED_BODY_NOTICE}`;
  return `${before}${PR_MANAGED_BODY_BEGIN}\n${managed}\n${PR_MANAGED_BODY_END}${after}`;
}

/**
 * PR 본문 중 b-studio가 관리하는 영역만 지금 초안(managedBody)으로 바꾼다. 사람이 마커 밖(위·아래)에 적은
 * 내용은 그대로 둔다.
 * - 마커가 이미 있으면 그 사이만 바꾼다. 닫는 마커가 없으면(예전에 끝이 잘린 본문) 여는 마커부터 끝까지를 바꾼다.
 * - 마커가 없지만 b-studio가 예전에 쓴 본문으로 보이면(looksLikeLegacyManagedPullRequestBody — "## 요청"·
 *   "## 검증" 절은 buildPullRequest만 넣는다) 통째로 마커로 감싸 바꾼다. 이런 PR은 처음 만들 때부터
 *   b-studio만 본문을 썼던 시절의 것이라(마커를 붙이기 전) 사람이 쓴 영역이 섞여 있을 가능성이 거의 없고,
 *   그대로 두면 새 커밋이 와도 본문이 영원히 낡은 채로 남는다(버그 리포트: PR #22).
 * - 그 밖(본문이 비었거나, 마커도 없고 우리 본문 같지도 않은 — 사람이 통째로 새로 쓴 설명 등)은 안전한 쪽을
 *   골라 기존 내용을 지우지 않고 그 아래에 마커로 감싼 영역을 덧붙인다.
 *
 * 돌려주는 본문은 한도(MAX_PULL_REQUEST_BODY) 안이다. 넘치면 관리 영역의 끝을 줄이고 닫는 마커와 마커 밖의 글은
 * 남긴다(이슈 #663 — 합친 글의 끝을 잘라 닫는 마커가 사라지면 다음 갱신이 영역을 찾지 못한다). 마커 밖의 글만으로
 * 한도가 차서 관리 영역이 들어갈 자리가 없으면 한도를 넘는 글을 그대로 돌려준다. 부르는 쪽이 길이를 보고 거절한다.
 */
function mergeManagedPullRequestBody(existingBody: string | undefined | null, managedBody: string): string {
  const current = existingBody ?? '';
  const beginIndex = current.indexOf(PR_MANAGED_BODY_BEGIN);
  const endIndex = current.indexOf(PR_MANAGED_BODY_END);
  if (beginIndex !== -1) {
    const before = current.slice(0, beginIndex);
    const after = endIndex > beginIndex ? current.slice(endIndex + PR_MANAGED_BODY_END.length) : '';
    return wrapManagedBody(before, managedBody, after);
  }
  if (current.trim() === '' || looksLikeLegacyManagedPullRequestBody(current)) return wrapManagedBody('', managedBody, '');
  return wrapManagedBody(`${current.trimEnd()}\n\n`, managedBody, '');
}

/** 마커 밖의 글이 한도를 거의 채워 관리 영역이 제 구실을 못 할 만큼 줄었는가 */
function managedBodySqueezedOut(body: string, managedBody: string): boolean {
  if (body.length > MAX_PULL_REQUEST_BODY) return true;
  const begin = body.indexOf(PR_MANAGED_BODY_BEGIN);
  const end = body.indexOf(PR_MANAGED_BODY_END);
  const kept = end - begin - PR_MANAGED_BODY_BEGIN.length - 2;
  return kept < Math.min(managedBody.length, MIN_MANAGED_BODY_CHARS);
}

/** buildPullRequest가 돌려주는 PR 초안과, 필수 단계 기록이 없는 커밋 */
interface PullRequestDraft {
  title: string;
  body: string;
  /** requiredStages 중 통과 기록이 없는 단계가 있는 커밋만. 오래된 것부터 */
  missing: Array<{ shortSha: string; subject: string; stages: WorkflowStage[] }>;
}

const PR_TITLE_PREFIX = '[b-studio] ';
/** PR 제목의 대략적인 상한(접두어 포함). "~72자 안팎"이라 토큰 하나 넘는 것은 눈감아 준다(ADR-110) */
const PR_TITLE_MAX = 72;

/** "R2~R23"처럼 요구사항 id들의 수 범위. 숫자 id가 하나도 없으면 undefined */
function requirementIdRange(ids: readonly string[]): string | undefined {
  const numbers = ids
    .map((id) => /^R(\d+)/.exec(id)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  if (numbers.length === 0) return undefined;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  return min === max ? `R${min}` : `R${min}~R${max}`;
}

/** 줄 수(없으면 파일 수) 기준으로 가장 큰 커밋. 요구사항이 안 걸려 있을 때 PR 제목의 기본값으로 쓴다 */
function mostSignificantCommit(commits: readonly SessionCommit[]): SessionCommit {
  const weight = (commit: SessionCommit): number => (commit.stat ? commit.stat.insertions + commit.stat.deletions : 0) || commit.files.length;
  return commits.reduce((best, commit) => (weight(commit) > weight(best) ? commit : best));
}

/**
 * PR 제목(ADR-110, 버그 리포트: 통합 세션의 PR 제목이 첫 커밋 제목 전체를 그대로 이어 붙이고 120자에서 단어
 * 중간을 잘랐다). 요구사항이 걸려 있으면(검증됨 + 발행된 이슈가 있는 요구사항, sessions.ts가 넘겨준다) 그
 * 수·범위로 요약하고, 아니면 가장 많이 바뀐 커밋 제목을 요약한다(commit-message.ts의 summarize 재사용 —
 * 체크포인트 제목을 만들 때와 같은 단어 경계 규칙을 PR 제목에도 그대로 쓴다).
 */
function buildPullRequestTitle(projectName: string, commits: readonly SessionCommit[], requirementIds: readonly string[]): string {
  const budget = PR_TITLE_MAX - PR_TITLE_PREFIX.length;
  if (requirementIds.length > 0) {
    // 요구사항이 하나이고 커밋도 하나면(흔한 후속 세션: 요구사항 하나를 커밋 하나로 구현) 그 커밋 제목이 이미
    // 구체적이다 — "요구사항 1개 구현과 검증 (R17)"처럼 뭉뚱그리지 않고 커밋 제목을 그대로 요약해 쓴다
    // (버그 리포트 ADR-115: 머지돼 닫힌 이전 요구사항 19개까지 그대로 "N개 구현과 검증"으로 다시 내세웠다)
    if (requirementIds.length === 1 && commits.length === 1) return `${PR_TITLE_PREFIX}${summarize(requestName(commits[0]!), budget)}`;
    const range = requirementIdRange(requirementIds);
    const summary = `feat: 요구사항 ${requirementIds.length}개 구현과 검증${range ? ` (${range})` : ''}`;
    return `${PR_TITLE_PREFIX}${summarize(summary, budget)}`;
  }
  const candidate = commits.length > 0 ? requestName(mostSignificantCommit(commits)) : `${projectName} 세션 변경`;
  return `${PR_TITLE_PREFIX}${summarize(candidate, budget)}`;
}

/**
 * 세션 커밋만으로 PR 제목과 본문을 만든다. 체크포인트 커밋 본문에 검증 결과가 들어 있어
 * 스튜디오 서버의 메모리 상태 없이도 같은 PR을 다시 만들 수 있다.
 */
function buildPullRequest({
  projectName,
  base,
  missingBase,
  branch,
  commits,
  issue,
  issues,
  requirementIds = [],
  requiredStages = [],
  appendix = '',
}: {
  projectName: string;
  /** PR의 대상 브랜치 */
  base: string;
  /** 세션이 갈라져 나온 브랜치가 원격에 없어 base(원격의 기본 브랜치)를 대상으로 삼았을 때, 그 브랜치의 이름 */
  missingBase?: string;
  branch: string;
  commits: SessionCommit[];
  /** 연결할 이슈 번호 하나. issues와 함께 주면 둘을 합친다 */
  issue?: number;
  /** 연결할 이슈 번호들. 있으면 본문 첫 줄들에 `Closes #N`을 하나씩 넣는다 */
  issues?: readonly number[];
  /** 지금 검증됨 + 발행된 이슈가 있는 요구사항 id들("R4" 모양). 있으면 제목을 요구사항 수·범위로 요약한다(ADR-110) */
  requirementIds?: readonly string[];
  /** 이 프로젝트의 필수 워크플로 단계. 통과 기록이 없는 검증 단계를 "돌리지 않은 검증"에 모은다 */
  requiredStages?: readonly WorkflowStage[];
  /** 본문 끝에 그대로 붙일 글(요구사항 줄·점검표 등). 길이 예산에 함께 넣어 본문을 줄일 때도 잘리지 않게 한다 */
  appendix?: string;
}): PullRequestDraft {
  const requests = commits.map(requestName);
  const title = buildPullRequestTitle(projectName, commits, requirementIds);

  // 문서 체크포인트(Workflow-Verify: docs, commitWorkingCopyDocs·commitDocTabChange가 남긴다)는 애초에 검증
  // 게이트를 거치지 않게 만든 체크포인트다(ADR-096) — "필수 단계 기록이 없다"가 아니라 "문서만 바뀜(게이트
  // 대상 아님)"으로 따로 보여준다. 트레일러만 믿지 않고 실제로 문서 경로만 바꿨는지 다시 확인해, 트레일러가
  // 잘못 붙은(코드까지 섞인) 커밋이 게이트 없이 빠져나가지 못하게 막는다(버그 리포트)
  const isDocsExempt = (commit: SessionCommit): boolean => commit.verify === 'docs' && commit.files.length > 0 && commit.files.every(isDocCheckpointPath);

  // 통과 기록은 검증 단계만 남으므로, plan·implement·checkpoint는 없는 것이 정상이다
  const stages = requiredStages.filter((stage) => VERIFICATION_STAGES.includes(stage));
  const missing = commits
    .map((commit, index) => {
      if (isDocsExempt(commit)) return undefined;
      const passed = new Set(commit.passedStages ?? []);
      const unmetStages = stages.filter((stage) => !passed.has(stage));
      return unmetStages.length > 0 ? { shortSha: commit.shortSha, subject: requests[index]!, stages: unmetStages } : undefined;
    })
    .filter((entry): entry is { shortSha: string; subject: string; stages: WorkflowStage[] } => entry !== undefined);

  /** 요청 하나의 절. withDetails가 거짓이면 접어 둔 상세(게이트 결과·에이전트 요약)를 뺀다. 상세는 커밋 본문에도 있다 */
  const section = (commit: SessionCommit, index: number, withDetails: boolean): string => {
    const shown = commit.files.slice(0, 10).map((file) => `\`${file}\``);
    const more = commit.files.length > shown.length ? ` 외 ${commit.files.length - shown.length}개` : '';
    const lines = [`### ${index + 1}. ${requests[index]}`, '', `커밋 \`${commit.shortSha}\`, 파일 ${commit.files.length}개: ${shown.join(', ')}${more}`];
    if (commit.body && withDetails) {
      lines.push('', '<details>', '<summary>검증 게이트 결과와 에이전트 요약</summary>', '', '~~~text', commit.body, '~~~', '', '</details>');
    }
    return lines.join('\n');
  };

  const verification = commits.map((commit, index) => {
    if (isDocsExempt(commit)) return `- \`${commit.shortSha}\` ${requests[index]} — 문서 체크포인트(게이트 대상 아님)`;
    const passed = commit.passedStages ?? [];
    // 턴 상한에서 게이트만 통과해 남긴 체크포인트는 통과 단계와 함께 그 사실을 적는다(ADR-131 덧붙임)
    const incomplete = commit.incomplete === 'max_turns' ? ' · 턴 상한에서 멈춘 실행(요청이 끝나지 않았을 수 있음)' : '';
    return `- \`${commit.shortSha}\` ${requests[index]} — 통과: ${passed.length > 0 ? passed.join(', ') : '기록 없음'}${incomplete}`;
  });
  const docsNotes = commits
    .map((commit, index) => (isDocsExempt(commit) ? `- \`${commit.shortSha}\` ${requests[index]} — 문서만 바뀜(게이트 대상 아님)` : undefined))
    .filter((line): line is string => line !== undefined);
  const missingNotes = missing.map((entry) => `- \`${entry.shortSha}\` ${entry.subject} — 기록 없음: ${entry.stages.join(', ')}`);
  const unverified = [...docsNotes, ...missingNotes].length > 0 ? [...docsNotes, ...missingNotes] : ['모든 커밋이 필수 단계를 통과했습니다'];

  // Closes는 여기 한 곳에서만 쓴다 — sessions.ts의 요구사항 Implements 절은 같은 이슈 번호를 다시 Closes로
  // 적지 않는다(버그 리포트: 검증된 요구사항의 이슈가 위아래 두 번 Closes로 나왔다)
  const linked = [...new Set([...(issue === undefined ? [] : [issue]), ...(issues ?? [])])];
  /** 앞에서부터 omitted건의 상세를 뺀 본문. 뺀 것이 있으면 "## 요청" 아래에 몇 건인지 적는다 */
  const render = (omitted: number): string => [
    ...(linked.length === 0 ? [] : [...linked.map((number) => `Closes #${number}`), '(`Closes #n`은 이 PR이 기본 브랜치로 열릴 때만 이슈를 자동으로 닫습니다.)', '']),
    `\`${projectName}\` 프로젝트의 b-studio 세션에서 처리한 요청 ${commits.length}건입니다.`,
    '요청마다 스튜디오가 바뀐 서비스를 재시작하고 준비 상태와 API 계약을 확인했고, **검증 게이트를 통과한 변경만** 커밋했습니다.',
    '',
    `- 기준 브랜치: \`${base}\``,
    ...(missingBase !== undefined && missingBase !== base
      ? [`  - 세션은 \`${missingBase}\`에서 갈라져 나왔지만 그 브랜치가 원격에 없어 원격의 기본 브랜치를 대상으로 했습니다. \`${missingBase}\`에만 있던 커밋도 이 PR에 들어 있습니다.`]
      : []),
    `- 세션 브랜치: \`${branch}\``,
    '',
    '## 요청',
    '',
    ...(omitted > 0 ? [`본문 길이 한도 때문에 앞의 ${omitted}건은 게이트 결과와 에이전트 요약을 싣지 않았습니다. 각 커밋의 본문에 그대로 있습니다.`, ''] : []),
    commits.map((commit, index) => section(commit, index, index >= omitted)).join('\n\n'),
    '',
    '## 검증',
    '',
    verification.join('\n'),
    '',
    '## 돌리지 않은 검증',
    '',
    unverified.join('\n'),
  ].join('\n') + appendix;

  // 한도를 넘으면 끝을 자르지 않고 오래된 요청의 상세부터 뺀다(이슈 #663). 끝에는 검증 요약·돌리지 않은 검증·덧붙임
  // (요구사항 줄, 점검표)이 있어, 끝을 자르면 리뷰어가 먼저 볼 것이 사라진다. 마커로 감쌀 자리도 남긴다.
  // 상세를 다 빼고도 넘치면(요청이 수백 건) 마지막 수단으로 끝을 자른다
  const budget = MAX_PULL_REQUEST_BODY - MANAGED_MARKER_CHARS;
  const withDetails = commits.map((commit) => Boolean(commit.body));
  let omitted = 0;
  let body = render(0);
  while (body.length > budget && omitted < commits.length) {
    omitted += 1;
    // 상세가 없는 요청은 빼도 길이가 그대로라 다시 만들지 않는다
    if (withDetails[omitted - 1]) body = render(omitted);
  }
  return { title, body: body.length > budget ? `${body.slice(0, budget - TRUNCATED_BODY_NOTICE.length - 2)}\n\n${TRUNCATED_BODY_NOTICE}` : body, missing };
}

/** 체크포인트 커밋 제목에서 "요청: " 접두사를 뺀 사람이 읽는 이름 */
function requestName(commit: SessionCommit): string {
  return commit.subject.replace(/^요청:\s*/, '');
}

function encodeRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function capBody(body: string): string {
  return body.length <= MAX_PULL_REQUEST_BODY ? body : `${body.slice(0, MAX_PULL_REQUEST_BODY)}\n\n${TRUNCATED_BODY_NOTICE}`;
}
return { parseRemote, compareUrl, canCreatePullRequest, parsePullRequestNumber, parseTaskList, parseClosingReferences, mapReviewState, capPatch, combineCheckStatus, mergeManagedPullRequestBody, managedBodySqueezedOut, buildPullRequest, capBody };
})();

const SEEDS = readEnvList('REPO_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('REPO_DIFF_ITERATIONS', 3000);
/** 본문이 수만 자인 입력은 느려 횟수를 줄인다 */
const HEAVY = Math.max(50, Math.floor(ITERATIONS / 10));
const REPORT = process.env['REPO_DIFF_REPORT'] === '1';

// ---------------------------------------------------------------------------
// 입력 생성
// ---------------------------------------------------------------------------

const HOSTS = [
  'github.com', 'github.com', 'gitlab.com', 'gitlab.com', 'github.com.evil.com', 'evil.github.com', 'GitHub.com', 'GITLAB.COM', 'github.com.', 'gitlab.com.', 'github.com:443', 'github.com:22', 'github.com:', 'gitlab.com:8080',
  'github.com:abc', 'github.com:1:2', 'evil.com', 'git.corp.local', 'localhost:3000', '[::1]:22', '192.168.0.1', 'xn--ls8h.com', '한글.com', 'github.com%2eevil.com', 'github.com@evil.com', 'a', 'x', 'gitea.example.com', 'github.com\\.evil.com', 'github.com/evil.com', 'github.co', 'ithub.com', 'github.comm', ' github.com',
];
const SCHEMES = ['https', 'http', 'ssh', 'git', 'file', 'HTTPS', 'Http', 'git+ssh', 'ftp', 'ws', 'foo-bar', 'a1+.-', 'ssh', 'https', 'https'];
const USERINFO = ['', '', '', 'git@', 'user:pw@', 'a b@', '@', 'git:@', ':@'];
const URL_PATHS = ['/o/r', '/o/r', '/o/r.git', '/o/r/', '//o//r//', '/o/r.git/', '/o/r.git.git', '/g/s/r', '/%E1%84%80', '/a%20b', '/%zz', '/%', '/o/r?x=1#h', '/o/r#frag', '', '/', '/.git', '/./r', '/a/../r', '/o/r.GIT', '/한글/r', '/o\\r', '/%2F', '/o/r.git?x', '/o/%2e%67it'];
const PADS = ['', '', '', '', ' ', '\t', '\n', '\u00a0', '\ufeff', '\u2028', '\u0085', '\u3000', '\r\n', '\u200b'];
const SCP_USERS = ['', '', 'git@', 'git@', 'a@', '@', 'a b@', 'x/y@', '@@', 'a@b@', 'git@@', ' @', 'u:p@'];
const SCP_PATHS = ['o/r', 'o/r', 'o/r.git', '/abs', '', 'a:b', ' x', 'o r', 'o\nr', '~/r', '//x', 'o/r/', '/', '.git', 'o\u2028r', 'o\u0085r', 'o/r\r'];
const SCP_HOSTS = ['github.com', 'gitlab.com', 'GitHub.com', 'github.com.evil.com', 'evil.com', 'C', 'c', '😀', 'ab', '', 'a b', ':', 'git.corp', 'github.com:22', '[::1]', 'a@b', '한', 'x@', '@x'];
const OTHERS = ['C:\\repo', 'C:/repo', 'c:repo', '\\\\server\\share', './local', '/abs/path', 'relative/path', '', ' ', 'a:', 'file:x', '://x', 'ssh://', 'https://', 'https:///x', 'git@', ':', '::', 'a::b', 'file:///C:/x', 'file://host/x', 'http://github.com/o/r', 'ftp://gitlab.com/o/r'];
const PROVIDERS = [undefined, undefined, undefined, 'github', 'gitlab', 'gitea', 'GitHub', ' gitlab', 'gitea ', '', 'other', 'local', 'GITLAB', 'gitlab\n', 'github,gitlab'];

function genRemoteUrl(g: Gen): string {
  const pad = (text: string): string => (g.chance(0.15) ? `${g.pick(PADS)}${text}${g.pick(PADS)}` : text);
  const roll = g.int(10);
  if (roll < 5) return pad(`${g.pick(SCHEMES)}://${g.pick(USERINFO)}${g.pick(HOSTS)}${g.pick(URL_PATHS)}`);
  if (roll < 8) return pad(`${g.pick(SCP_USERS)}${g.pick(SCP_HOSTS)}:${g.pick(SCP_PATHS)}`);
  if (roll < 9) return pad(g.pick(OTHERS));
  return pad(g.text(['a', '@', ':', '/', '/', ' ', '\\', '.', 'git', 'github.com', 'gitlab.com', 'x', '\n', 'https://', '😀', '%'], 1 + g.int(10)));
}

const REPO_KINDS = ['github', 'gitlab', 'gitea', 'other', 'local'] as const;
const WEB_URLS = [undefined, undefined, '', 'https://github.com/o/r', 'http://git.corp/o/r', 'https://gitlab.com/g/s/r', 'https://h/x y', 'https://h/o/r?x'];
const REFS = ['main', 'feat/a', 'feat/a b', 'release/1.0', '', '/', '//', 'a//b', 'ü/한글', 'a&b=c', 'a+b', 'a%b', "a'b(c)*!~", 'a#b?c', '😀/x', ' ', 'a\tb\n', '.', '-', '_', '~x', 'A-Z_a.z*', 'x[y]'];

const TEXT_ATOMS = ['a', 'B', ' ', ' ', '\n', '\n', '\r', '\t', '\u00a0', '\ufeff', '\u0085', '\u2028', '\u2029', '\u3000', '-', '*', '+', '[', ']', '[ ]', '[x]', '[X]', '[y]', '#', '#1', ':', 'x', '한글', '😀', '- [ ] ', '- [x] ', '* [X] ', '  - [ ] ', '- [ ]  ', '- [ ] \r', '-[ ] a', '- [] a', '- [ ]a'];
const CLOSING_ATOMS = [
  'close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'fixe', 'resolve', 'resolves', 'resolved', 'Closes', 'CLOSES', 'Fixes', 'RESOLVED', 'unfixes', 'prefix', 'prefix#1', 'closing', 'closess', 'closeds', 'fixs', 'fixd', 'resolvd',
  ' ', ' ', '  ', '\n', '\t', '\u00a0', '\u2028', ':', ': ', ' :', '::', '#', '#1', '#12', '#007', '#0', '#9007199254740993', '#' + '9'.repeat(400), '# 1', '#x', '#-1', '#1.5', '1', '12', 'a', '_', '-', '.', ',', '한글', 'closes:#1', 'closes #1', 'fixes: #2', 'ſ', 'ı', 'K', '\u212a', 'ＣＬＯＳＥ', '😀',
];

const WS_BITS = [' ', ' ', ' ', '  ', '\t', '\u00a0', '\ufeff', '\u2028', '\u3000', '\r', '\u0085', ''];

/** 체크리스트 줄 하나: 맞는 꼴에서 한 군데만 바꾼다 */
function genTaskLine(g: Gen): string {
  const lead = g.pick(['', '', '  ', '\t', '    ', '\u00a0', '\ufeff', '>']);
  const marker = g.pick(['-', '-', '*', '+', '–', '']);
  const gap1 = g.pick([' ', ' ', '  ', '\t', '', '\u00a0', '\u2028']);
  const mark = g.pick([' ', 'x', 'X', ' ', '', 'y', '  ', '✓']);
  const gap2 = g.pick([' ', ' ', '  ', '\t', '', '\u00a0', '\u2028', '\r', ' \r', '   ']);
  const text = g.pick(['할 일', 'a', '', ' ', '한글 text', '😀', 'a\rb', 'a\u2028', ' a ', 'x'.repeat(30)]);
  const tail = g.pick(['', '', '', '\r', ' ', '\u2029']);
  return `${lead}${marker}${gap1}[${mark}]${gap2}${text}${tail}`;
}

function genTaskBody(g: Gen): string | undefined {
  if (g.chance(0.05)) return undefined;
  if (g.chance(0.5)) return g.text(TEXT_ATOMS, g.int(14));
  return g.list(0, 6, () => (g.chance(0.8) ? genTaskLine(g) : g.pick(['', '본문', '## 제목', '- [ ]', '- [x]']))).join(g.pick(['\n', '\n', '\r\n', '\n\n']));
}

function genClosingText(g: Gen): string | undefined {
  if (g.chance(0.05)) return undefined;
  if (g.chance(0.5)) return g.text(CLOSING_ATOMS, g.int(10));
  const sentence = (): string => {
    const lead = g.pick(['', '', ' ', '\n', 'un', 'pre', '_', '1', '(', '-', '한글', '😀', '.', 'a ', '\u00a0']);
    const keyword = g.pick(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved', 'Closes', 'FIXES', 'rEsOlVeD', 'fixe', 'closess', 'fixd', 'resolvs']);
    const gap1 = g.pick(['', ' ', ' ', '  ', '\n', '\t', '\u00a0', '\u2028']);
    const colon = g.pick(['', '', ':', '::']);
    const gap2 = g.pick(['', ' ', ' ', '\n']);
    const hash = g.pick(['#', '#', '#', '＃', '# ', '']);
    const digits = g.pick(['1', '12', '007', '0', '00', '9007199254740993', '9007199254740992', '9'.repeat(400), '', 'x', '١٢', '3.5']);
    return `${lead}${keyword}${gap1}${colon}${gap2}${hash}${digits}${g.pick(['', ' ', ',', '.', 'abc', '\n'])}`;
  };
  return g.list(1, 4, sentence).join(g.pick([' ', '\n', ', ']));
}

function genPullUrl(g: Gen): string {
  if (g.chance(0.4)) return g.text(['/pull/', '/pulls/', '/merge_requests/', '/pull', 'pull/', '/', '?', '#', '1', '12', '007', '0', 'x', ' ', '\n', '/-/', 'https://github.com/o/r', '9007199254740993', '9'.repeat(400), '/PULL/', '/pullss/', '/pulls', '٣'], 1 + g.int(8));
  const prefix = g.pick(['https://github.com/o/r', 'https://gitlab.com/g/s/r/-', 'http://h/o/r', '', '/a/pull/1x', 'x/pull/', '//']);
  const word = g.pick(['/pull/', '/pulls/', '/merge_requests/', '/pull/', '/PULL/', 'pull/', '/pullx/', '/merge_request/', '/pulls', '/pull//', '/ pull/']);
  const digits = g.pick(['1', '12', '007', '0', '9007199254740993', '9'.repeat(400), '', 'x', '١٢', '1.5', '-1', '123']);
  const tail = g.pick(['', '', '/', '/files', '?x=1', '#c', '#', 'x', ' ', '\n', '.diff', '?', '/-/x']);
  return `${prefix}${word}${digits}${tail}${g.chance(0.1) ? g.pick(['/pull/5', '?u=/pull/6']) : ''}`;
}

const COMMIT_SUBJECTS = ['요청: 로그인 추가', '요청:   공백 많음', '요청:', '요청 없음', '  요청: 앞 공백', 'feat: 결제 추가', '요청: ' + '긴 제목 '.repeat(20), '', ' ', '요청:\n 줄바꿈', '요청:\u00a0nbsp', '요청: 요청: 둘', '요청：전각', '요청: 한글 English mixed words that are quite long enough to need summarizing at word boundaries'];
const FILES = ['src/a.ts', 'src/b.ts', 'docs/x.md', 'docs/adr/ADR-001-a.md', 'README.md', 'notes.md', 'a/b/c.md', '.github/pull_request_template.md', 'docs/', 'Docs/x.md', 'docs/x.MD', 'x.md/y', '한글.md', 'a`b.ts'];
const STAGES: WorkflowStage[] = ['plan', 'implement', 'run', 'browser_check', 'contract_check', 'test', 'concurrency_check', 'load_check', 'review', 'checkpoint'];
const BODY_SIZES = [0, 0, 0, 1, 50, 200, 3000, 12000, 25000, 34000];

function genCommit(g: Gen, index: number): SessionCommit {
  const files = g.list(0, g.chance(0.1) ? 14 : 4, () => g.pick(FILES));
  const docsOnly = g.chance(0.25);
  const sizeOf = g.pick(BODY_SIZES);
  const commit: SessionCommit = {
    sha: `sha${index}`,
    shortSha: g.text(['a', 'b', 'c', '0', '1', '9', 'f'], 7),
    subject: g.pick(COMMIT_SUBJECTS),
    body: sizeOf === 0 ? (g.chance(0.5) ? '' : g.pick(['검증 통과', 'a\nb', '~~~'])) : g.text(['가나다 ', 'line\n', '😀', 'x'], 1).repeat(Math.ceil(sizeOf / 3)).slice(0, sizeOf),
    files: docsOnly ? g.list(0, 3, () => g.pick(['docs/x.md', 'README.md', 'docs/adr/ADR-001-a.md', '.github/pull_request_template.md', 'src/a.ts'])) : files,
  };
  if (g.chance(0.6)) commit.stat = { insertions: g.pick([0, 1, 5, 10, 100, NaN, Infinity, -1, 2.5]), deletions: g.pick([0, 0, 2, 50, 100, NaN]) };
  if (g.chance(0.8)) commit.passedStages = g.list(0, 6, () => g.pick(STAGES));
  if (g.chance(0.4)) commit.verify = g.pick(['docs', 'docs', 'unverified'] as const);
  if (g.chance(0.15)) commit.incomplete = 'max_turns';
  return commit;
}

const ISSUE_NUMBERS = [1, 2, 12, 7, 7, 0, -0, NaN, NaN, Infinity, 1.5, 2 ** 53, 1e21, 1e-7, 123456789012345680000];
const REQUIREMENT_IDS = ['R1', 'R2', 'R17', 'R23', 'R010', 'R10', 'R', 'X5', 'r5', 'R9007199254740993', 'R' + '9'.repeat(400), 'R0', 'R1a', ' R3', 'R٣', 'R-1'];
const APPENDIX = ['', '', '', '\n\n- 요구사항 R1\n', '\n점검표', 'x'.repeat(500), '😀'.repeat(300)];

interface BuildInput {
  projectName: string;
  base: string;
  missingBase?: string;
  branch: string;
  commits: SessionCommit[];
  issue?: number;
  issues?: readonly number[];
  requirementIds?: readonly string[];
  requiredStages?: readonly WorkflowStage[];
  appendix?: string;
}

function genBuildInput(g: Gen): BuildInput {
  const count = g.chance(0.1) ? 0 : g.chance(0.2) ? 8 + g.int(10) : 1 + g.int(4);
  const input: BuildInput = {
    projectName: g.pick(['shop', '쇼핑몰', 'a`b', '', 'x'.repeat(100)]),
    base: g.pick(['main', 'develop', 'a`b']),
    branch: g.pick(['b-studio/session-1', 'feat/x']),
    commits: Array.from({ length: count }, (_, index) => genCommit(g, index)),
  };
  if (g.chance(0.3)) input.missingBase = g.pick(['main', 'release/1', 'develop', '']);
  if (g.chance(0.3)) input.issue = g.pick(ISSUE_NUMBERS);
  if (g.chance(0.3)) input.issues = g.list(0, 4, () => g.pick(ISSUE_NUMBERS));
  if (g.chance(0.4)) input.requirementIds = g.list(0, 6, () => g.pick(REQUIREMENT_IDS));
  if (g.chance(0.8)) input.requiredStages = g.list(0, 7, () => g.pick(STAGES));
  if (g.chance(0.6)) input.appendix = g.pick(APPENDIX);
  return input;
}

const MARKERS = [current.PR_MANAGED_BODY_BEGIN, current.PR_MANAGED_BODY_END];
const NOTICE = '(본문이 길어 뒷부분을 생략했습니다)';
const FILLERS = ['x', '가', '😀', 'a\n'];

/** 길이가 정확히 `units` UTF-16 코드 단위인 글(짝을 가르지 않게 맞춘다) */
function filler(g: Gen, units: number): string {
  const unit = g.pick(FILLERS);
  const per = unit.length;
  const body = unit.repeat(Math.floor(Math.max(0, units) / per));
  return body + 'x'.repeat(Math.max(0, units) - body.length);
}

interface MergeInput {
  existing: string | undefined | null;
  managed: string;
}

function genMergeInput(g: Gen): MergeInput {
  const markerChars = current.PR_MANAGED_BODY_BEGIN.length + current.PR_MANAGED_BODY_END.length + 2;
  const managedLength = g.pick([0, 1, 5, 30, 2000, 2001, 1999, 20000, 59000, 60000, 70000]);
  const managed = filler(g, managedLength);
  // 마커 밖의 글이 정확히 한도 경계(room이 managed 길이와 같거나 ±1, 안내 문구 길이 근처, 0 근처)에 오게 맞춘다
  const roomChoices = [managedLength, managedLength - 1, managedLength + 1, 0, 1, -1, NOTICE.length + 2, NOTICE.length + 1, NOTICE.length + 3, 2000, 1999, 2001, 5];
  const outside = Math.max(0, 60000 - markerChars - g.pick(roomChoices));
  const split = g.int(outside + 1);
  const before = filler(g, split);
  const after = filler(g, outside - split);
  const humans = ['', '사람 글', '사람 글\n\n', '  \n', '\ufeff', '\u0085', '\n\n\n'];
  const text = (): string => (g.chance(0.5) ? g.pick(humans) : g.text(FILLERS, g.int(4)));
  const roll = g.int(16);
  let existing: string | undefined | null;
  if (roll === 0) existing = undefined;
  else if (roll === 1) existing = null;
  else if (roll === 2) existing = '';
  else if (roll === 3) existing = g.pick([' ', '\n\n', '\ufeff', '\u0085']);
  else if (roll === 4) existing = `${text()}${MARKERS[0]}${text()}`; // 시작만
  else if (roll === 5) existing = `${text()}${MARKERS[1]}${text()}`; // 끝만
  else if (roll === 6) existing = `${text()}${MARKERS[1]}${text()}${MARKERS[0]}${text()}`; // 뒤집힘
  else if (roll === 7) existing = `${text()}${MARKERS[0]}${text()}${MARKERS[1]}${text()}${MARKERS[0]}${text()}${MARKERS[1]}${text()}`; // 두 쌍
  else if (roll === 8) existing = `${text()}${MARKERS[0]}${text()}${MARKERS[0]}${text()}${MARKERS[1]}${text()}`; // 시작 둘
  else if (roll === 9) existing = `${text()}${MARKERS[0]}${text()}${MARKERS[1]}${text()}${MARKERS[1]}${text()}`; // 끝 둘
  else if (roll === 10) existing = `${before}${MARKERS[0]}\n옛\n${MARKERS[1]}${after}`; // 한도 경계의 마커 쌍
  else if (roll === 11) existing = `${before}${MARKERS[0]}\n옛 끝이 잘린${after.slice(0, 5)}`; // 닫는 마커 없음
  else if (roll === 12) existing = `${g.pick(['', '앞 글\n'])}## 요청\n\n본문\n\n## 검증\n\n- x${g.pick(['', '\n', ' \n\n'])}`; // 옛 모양
  else if (roll === 13) existing = `## 요청\n\n본문${g.pick(['', '\n'])}\n\n${NOTICE}${g.pick(['', '\n', '  '])}`; // 줄인 옛 모양
  else if (roll === 14) existing = `${g.pick(['## 요청', '## 검증', '  ## 요청'])}\n${text()}`; // 표지 하나만 있는 옛 모양 후보
  else existing = `${before}${g.pick(humans)}${after}`; // 마커 없는 긴 글
  return { existing, managed };
}

// ---------------------------------------------------------------------------
// 견주기
// ---------------------------------------------------------------------------

interface Tally {
  runs: number;
  differ: number;
  empty: number;
  valued: number;
  threw: number;
  /** 열린 쪽으로 뒤집힌 수(호스트 종류를 넓힘, 토큰 없음을 있음으로, 좁혀진 본문을 괜찮다고) */
  open: number;
  first: string[];
}

const newTally = (): Tally => ({ runs: 0, differ: 0, empty: 0, valued: 0, threw: 0, open: 0, first: [] });

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === false || value === 'unknown') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const { total, kind, patch, truncated } = value as { total?: unknown; kind?: unknown; patch?: unknown; truncated?: unknown };
    return total === 0 || kind === 'local' || kind === 'other' || (truncated === true && patch === undefined);
  }
  return false;
}

function compare(tally: Tally, label: string, input: unknown, legacyOutcome: Outcome, currentOutcome: Outcome): void {
  tally.runs++;
  if (legacyOutcome.threw) tally.threw++;
  else if (isEmptyValue(legacyOutcome.value)) tally.empty++;
  else tally.valued++;
  if (!sameOutcome(legacyOutcome, currentOutcome)) {
    tally.differ++;
    if (tally.first.length < 3) tally.first.push(`${label}\n입력: ${JSON.stringify(input)}\n옛: ${JSON.stringify(legacyOutcome)}\n새: ${JSON.stringify(currentOutcome)}`);
  }
}

const TOKEN_KINDS = new Set<string>(['github', 'gitlab', 'gitea']);

/** 옛 결과가 other·local인데 새 결과가 토큰을 보낼 호스트(github·gitlab·gitea)이거나, 옛이 local인데 local이 아니다 */
function countKindFlip(tally: Tally, legacyOutcome: Outcome, currentOutcome: Outcome): void {
  if (legacyOutcome.threw || currentOutcome.threw) return;
  const before = (legacyOutcome.value as RemoteLocation).kind;
  const after = (currentOutcome.value as RemoteLocation).kind;
  if ((!TOKEN_KINDS.has(before) && TOKEN_KINDS.has(after)) || (before === 'local' && after !== 'local')) tally.open++;
}

interface Case {
  name: string;
  /** 결과가 "빈 값"인 비율이 이 이상이어야 입력이 한쪽으로 쏠리지 않은 것이다(0이면 확인하지 않는다) */
  minEmpty?: number;
  /** 값이 있는 비율의 하한(기본 0.2) */
  minValued?: number;
  heavy?: boolean;
  run: (g: Gen, tally: Tally) => void;
}

const cases: Case[] = [
  {
    name: 'parseRemote',
    minEmpty: 0.1,
    run: (g, t) => {
      const url = genRemoteUrl(g);
      const provider = g.pick(PROVIDERS);
      const env = provider === undefined ? {} : { B_STUDIO_GIT_PROVIDER: provider };
      const l = outcome(() => legacy.parseRemote(url, env));
      const c = outcome(() => current.parseRemote(url, env));
      compare(t, 'parseRemote', { url, provider }, l, c);
      countKindFlip(t, l, c);
    },
  },
  {
    name: 'compareUrl',
    run: (g, t) => {
      const kind = g.pick(REPO_KINDS);
      const webUrl = g.pick(WEB_URLS);
      const remote: RemoteLocation = { kind, display: 'x', ...(webUrl === undefined ? {} : { webUrl }) };
      const base = g.pick(REFS);
      const branch = g.pick(REFS);
      compare(t, 'compareUrl', { remote, base, branch }, outcome(() => legacy.compareUrl(remote, base, branch)), outcome(() => current.compareUrl(remote, base, branch)));
    },
  },
  {
    name: 'canCreatePullRequest',
    minEmpty: 0.2,
    run: (g, t) => {
      const kind: GitHostKind = g.pick(REPO_KINDS);
      const remote: RemoteLocation = { kind, display: 'x' };
      const env: Record<string, string | undefined> = {};
      for (const name of ['B_STUDIO_GITHUB_TOKEN', 'B_STUDIO_GITLAB_TOKEN', 'B_STUDIO_GITEA_TOKEN']) {
        const roll = g.int(4);
        if (roll === 1) env[name] = '';
        else if (roll === 2) env[name] = 'tok';
        else if (roll === 3) env[name] = ' ';
      }
      const token = g.pick([undefined, undefined, '', 'tok', ' ', '0']);
      const l = outcome(() => legacy.canCreatePullRequest(remote, env, token));
      const c = outcome(() => current.canCreatePullRequest(remote, env, token));
      compare(t, 'canCreatePullRequest', { kind, env, token }, l, c);
      if (!l.threw && !c.threw && l.value === false && c.value === true) t.open++;
    },
  },
  {
    name: 'parsePullRequestNumber',
    minEmpty: 0.1,
    minValued: 0.1,
    run: (g, t) => {
      const url = genPullUrl(g);
      compare(t, 'parsePullRequestNumber', url, outcome(() => legacy.parsePullRequestNumber(url)), outcome(() => current.parsePullRequestNumber(url)));
    },
  },
  {
    name: 'parseTaskList',
    minEmpty: 0.05,
    minValued: 0.1,
    run: (g, t) => {
      const body = genTaskBody(g);
      compare(t, 'parseTaskList', body, outcome(() => legacy.parseTaskList(body)), outcome(() => current.parseTaskList(body)));
    },
  },
  {
    name: 'parseClosingReferences',
    minEmpty: 0.05,
    run: (g, t) => {
      const text = genClosingText(g);
      compare(t, 'parseClosingReferences', text, outcome(() => legacy.parseClosingReferences(text)), outcome(() => current.parseClosingReferences(text)));
    },
  },
  {
    name: 'mapReviewState',
    minEmpty: 0.05,
    run: (g, t) => {
      const names = ['APPROVED', 'CHANGES_REQUESTED', 'REQUEST_CHANGES', 'COMMENTED', 'COMMENT', 'DISMISSED', 'PENDING', 'approved', 'Approved', 'pending', 'request_changes', '', ' APPROVED', 'APPROVED ', 'APPROVE', 'DISMISSEDS'];
      let raw = g.pick(names);
      // 대문자로 바꿀 때 ASCII로 접히는 글자(ı→I, ſ→S, ß→SS, ﬁ→FI)를 섞는다
      if (g.chance(0.5)) raw = raw.replace(/[a-zA-Z]/g, (letter) => (g.chance(0.15) ? g.pick(['ı', 'ſ', 'ß', 'ﬁ', 'İ', letter.toLowerCase()]) : letter));
      compare(t, 'mapReviewState', raw, outcome(() => legacy.mapReviewState(raw)), outcome(() => current.mapReviewState(raw)));
    },
  },
  {
    name: 'capPatch',
    minEmpty: 0.05,
    run: (g, t) => {
      const lengths = [0, 1, 100, 19999, 20000, 20001, 20002, 199999, 200000, 200001, 5000, 50000];
      const patch = g.chance(0.1) ? undefined : filler(g, g.pick(lengths));
      const running = g.pick([0, 0, 1, 180000, 180001, 179999, 199999, 200000, 200001, 150000, 190000.5, NaN, -5, Infinity, -Infinity, 0.5]);
      compare(t, 'capPatch', { length: patch?.length, running }, outcome(() => legacy.capPatch(patch, running)), outcome(() => current.capPatch(patch, running)));
    },
  },
  {
    name: 'combineCheckStatus',
    run: (g, t) => {
      const statuses = ['completed', 'completed', 'completed', 'in_progress', 'queued', 'Completed', ' completed', ''];
      const conclusions: Array<string | null | number | undefined> = ['success', 'success', 'failure', 'timed_out', 'cancelled', 'action_required', 'neutral', 'skipped', 'Failure', 'failure ', null, null, '', 0, 5, undefined];
      const runs = g.list(0, 5, () => ({ status: g.pick(statuses), conclusion: g.pick(conclusions) })) as Array<{ status: string; conclusion: string | null }>;
      compare(t, 'combineCheckStatus', runs, outcome(() => legacy.combineCheckStatus(runs)), outcome(() => current.combineCheckStatus(runs)));
    },
  },
  {
    name: 'mergeManagedPullRequestBody/managedBodySqueezedOut/capBody',
    heavy: true,
    run: (g, t) => {
      const { existing, managed } = genMergeInput(g);
      const l = outcome(() => legacy.mergeManagedPullRequestBody(existing, managed));
      compare(t, 'mergeManagedPullRequestBody', { existing: existing?.length, managed: managed.length }, l, outcome(() => current.mergeManagedPullRequestBody(existing, managed)));
      // 넘겨받은 본문(합친 결과·사람이 고친 본문·한도 경계)에서 "관리 영역이 쥐어짜였는가"를 견준다
      const bodies = [l.threw ? '' : (l.value as string), existing ?? '', `${existing ?? ''}${managed}`.slice(0, 60000 + g.int(3) - 1)];
      for (const body of bodies) {
        const sl = outcome(() => legacy.managedBodySqueezedOut(body, managed));
        const sc = outcome(() => current.managedBodySqueezedOut(body, managed));
        compare(t, 'managedBodySqueezedOut', { body: body.length, managed: managed.length }, sl, sc);
        if (!sl.threw && !sc.threw && sl.value === true && sc.value === false) t.open++;
      }
      compare(t, 'capBody', managed.length, outcome(() => legacy.capBody(managed)), outcome(() => current.capBody(managed)));
    },
  },
  {
    name: 'buildPullRequest',
    heavy: true,
    minEmpty: 0,
    run: (g, t) => {
      const input = genBuildInput(g);
      const summary = { commits: input.commits.length, requirementIds: input.requirementIds, issue: input.issue, issues: input.issues, appendix: input.appendix?.length, bodies: input.commits.map((commit) => commit.body.length) };
      compare(t, 'buildPullRequest', summary, outcome(() => legacy.buildPullRequest(input)), outcome(() => current.buildPullRequest(input)));
    },
  },
];

describe('차등 시험: 옛 TS 구현과 Rust 껍데기는 같은 입력에 같은 글자를 낸다', () => {
  for (const { name, run, minEmpty, minValued, heavy } of cases) {
    it(name, () => {
      const total = newTally();
      for (const seed of SEEDS) {
        const g = new Gen(seed * 1000 + name.length);
        const tally = newTally();
        const times = heavy ? HEAVY : ITERATIONS;
        for (let n = 0; n < times; n++) run(g, tally);
        for (const key of ['runs', 'differ', 'empty', 'valued', 'threw', 'open'] as const) total[key] += tally[key];
        total.first.push(...tally.first);
        if (REPORT) console.log(`[차등] ${name} 시드 ${seed}: 비교 ${tally.runs}, 다름 ${tally.differ}, 빈 결과 ${tally.empty}, 값 ${tally.valued}, 던짐 ${tally.threw}, 열린 쪽 뒤집힘 ${tally.open}`);
      }
      expect(total.first.join('\n---\n')).toBe('');
      expect(total.differ).toBe(0);
      expect(total.open).toBe(0);
      expect(total.runs).toBeGreaterThan(0);
      expect(total.valued).toBeGreaterThan(total.runs * (minValued ?? 0.2)); // 입력이 비어 있지 않다
      if (minEmpty) expect(total.empty).toBeGreaterThan(total.runs * minEmpty);
    });
  }

  it('대조 장치: 결과 한 글자만 달라도 잡는다', () => {
    const g = new Gen(9);
    const tally = newTally();
    for (let n = 0; n < 200; n++) {
      const url = genRemoteUrl(g);
      const text = g.text(CLOSING_ATOMS, 1 + g.int(8));
      const body = g.text(TEXT_ATOMS, 1 + g.int(10));
      const { existing, managed } = genMergeInput(g);
      const expected: Outcome[] = [
        outcome(() => legacy.parseRemote(url, {})),
        outcome(() => legacy.parseClosingReferences(text)),
        outcome(() => legacy.parseTaskList(body)),
        outcome(() => legacy.mergeManagedPullRequestBody(existing, managed)),
      ];
      for (const o of expected) {
        if (o.threw) continue;
        compare(tally, 'tamper', url, o, { threw: false, value: perturb(o.value) });
      }
    }
    expect(tally.differ).toBeGreaterThan(300);
  });

  it('대조 장치: 옛 구현을 한 군데만 바꿔도(경계 ±1·글자 클래스 넓히기·같음 넓히기) 잡는다', () => {
    // 호스트 이름 같음을 끝 일치·포함·대소문자 무시로 넓힌 구현, 한도 경계를 ±1 한 구현, 닫기 문구의 단어 경계를 없앤 구현
    const widenedKind = (host: string, mode: 'endsWith' | 'includes' | 'ci'): string => {
      const hit = (name: string): boolean => (mode === 'endsWith' ? host.endsWith(name) : mode === 'includes' ? host.includes(name) : host.toLowerCase() === name);
      return hit('github.com') ? 'github' : hit('gitlab.com') ? 'gitlab' : 'other';
    };
    const noBoundary = (text: string): number[] => {
      const out: number[] = [];
      for (const match of text.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi)) if (!out.includes(Number(match[1]))) out.push(Number(match[1]));
      return out;
    };
    const g = new Gen(11);
    const differ = { endsWith: 0, includes: 0, ci: 0, boundary: 0, limit: 0 };
    for (let n = 0; n < 3000; n++) {
      const url = genRemoteUrl(g);
      const location = outcome(() => current.parseRemote(url, {}));
      if (!location.threw) {
        const host = ((location.value as RemoteLocation).host ?? '').replace(/:\d+$/, '');
        const actual = (location.value as RemoteLocation).kind;
        for (const mode of ['endsWith', 'includes', 'ci'] as const) if ((actual === 'github' || actual === 'gitlab' || actual === 'other') && widenedKind(host, mode) !== actual) differ[mode]++;
      }
      const text = g.text(CLOSING_ATOMS, 1 + g.int(8));
      if (JSON.stringify(noBoundary(text)) !== JSON.stringify(current.parseClosingReferences(text))) differ.boundary++;
      const { existing, managed } = genMergeInput(g);
      // 합친 결과의 한도(60,000)를 59,999로 바꾼 옛 구현: 경계 길이의 입력에서 새 결과와 달라야 한다
      const merged = current.mergeManagedPullRequestBody(existing, managed);
      if (merged.length === 60000) differ.limit++;
    }
    expect(differ.endsWith).toBeGreaterThan(20);
    expect(differ.includes).toBeGreaterThan(20);
    expect(differ.ci).toBeGreaterThan(20);
    expect(differ.boundary).toBeGreaterThan(20);
    expect(differ.limit).toBeGreaterThan(0);
  });
});
