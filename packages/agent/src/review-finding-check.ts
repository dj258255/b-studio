/**
 * AI 리뷰 지적의 위치 대조와 처리율(이슈 #1440).
 *
 * 리뷰어는 diff만 보고 지적을 내므로 파일·줄이 diff에 없는 지적이 섞인다. 이 모듈은 지적마다 **리뷰어가 실제로 받은 diff**
 * (truncateDiff를 거친 것)와 기계로 맞춰 본다. 표시와 기록만 하며 리뷰의 판정(막는지 여부, nextPrReviewStep)은 바꾸지 않는다.
 *
 * 위치 대조(checkFindingLocations) 결과는 셋이다.
 *  - in_diff: 파일이 diff에 있고, 줄이 없거나 바뀐 곳에서 문맥 허용(FINDING_LINE_CONTEXT) 안이다
 *  - not_in_diff: 파일이 diff에 없거나(file_missing), 줄이 바뀐 곳에서 문맥 허용을 넘는다(line_outside)
 *  - unverified("확인 못 함"): 맞춰 볼 수 없었다. 거르지도 통과로 세지도 않는다. 경로를 못 읽음·애매함(bad_location),
 *    크기 때문에 본문을 생략한 파일(file_omitted), diff 뒷부분이 잘려 못 본 곳일 수 있음(diff_truncated), 바이너리의 줄(binary)
 *
 * 문맥 허용은 3줄이다. git이 기본으로 바뀐 줄 앞뒤에 3줄씩 보여 주므로(리뷰어가 diff에서 볼 수 있는 범위와 같다) 그 안은 "diff를 보고 가리킨 곳"이고,
 * 그 밖은 리뷰어가 볼 수 없던 곳을 추측한 것이다. 리뷰어가 지운 줄을 옛 파일 줄 번호로 가리킬 수도 있어 지운 줄(옛 번호)도 같은 허용으로 본다.
 *
 * 경로는 diff 머리글의 경로와 같은 규칙으로 맞춘다: 먼저 구분자(\)·"./"·겹친 "/"만 고쳐 정확히 같은 것을 찾고, 없으면 "a/"·"b/" 접두를 뗀 것,
 * 그다음 대소문자·유니코드 정규화·보이지 않는 글자·끝의 점과 공백을 무시한 느슨한 비교를 한다. 느슨한 비교에 둘 이상이 걸리면 어느 파일인지 모르므로 확인 못 함이다.
 * 절대 경로·".." 조각·빈 값은 읽을 수 없는 경로(확인 못 함)다. 이 비교는 표시용이라 막는 검사가 아니다.
 *
 * 처리율(checkFindingsAddressed·summarizeAddressRate)의 정의:
 *  - 지적마다 그 지적이 나온 라운드의 리뷰 이후(그 라운드가 본 끝 커밋부터 지금 HEAD까지)의 diff를 본다
 *  - 반영됨: 지적한 줄이 그 diff에서 지워졌거나 바뀌었거나, 그 줄 바로 앞뒤에 줄이 끼워졌다(리뷰한 시점의 줄 번호 기준이라 이후 diff의 옛 파일 쪽 번호와 맞춘다). 줄 없는 지적은 그 파일이 바뀌었으면 반영됨
 *  - 반영 안 됨: 그 파일이 이후 diff에 없거나, 있어도 지적한 줄이 안 바뀌었다
 *  - 모름: 위치를 맞춰 보지 못했거나(확인 못 함·diff에 없음·대조 기록 없음), 이후 diff를 읽지 못했거나, 바이너리 파일의 줄이다
 *  - 처리율 = 반영됨 / (반영됨 + 반영 안 됨). 모름은 분모에 넣지 않고 따로 센다. 센 것이 없으면 처리율은 없다(모름)
 *  - "바뀌었다"는 사실만 센다. 그 변경이 지적을 실제로 고쳤는지는 보지 않는다(추정하지 않는다). 같은 지적이 라운드마다 되풀이되면 라운드마다 센다
 */
import type { PrReviewFinding, TruncatedDiff } from './pr-review';

/** 줄 대조의 문맥 허용(줄). git 기본 unified 문맥과 같다 */
export const FINDING_LINE_CONTEXT = 3;

export type FindingLocationStatus = 'in_diff' | 'not_in_diff' | 'unverified';
export type FindingLocationReason = 'file_missing' | 'line_outside' | 'file_omitted' | 'diff_truncated' | 'bad_location' | 'binary';
export interface FindingLocationCheck {
  status: FindingLocationStatus;
  reason?: FindingLocationReason;
}

export type FindingAddressStatus = 'addressed' | 'not_addressed' | 'unknown';

type Located = Pick<PrReviewFinding, 'file'> & { line?: number };

interface DiffSection {
  oldPath?: string;
  newPath?: string;
  omitted: boolean;
  binary: boolean;
  /** 새 파일 쪽에서 더해진 줄 번호 */
  added: number[];
  /** 새 파일 쪽에서 지워진 곳의 앞뒤 줄 번호(지운 줄 자리) */
  deletionSpots: number[];
  /** 옛 파일 쪽에서 지워진 줄 번호 */
  deleted: number[];
  /** 옛 파일 쪽에서 줄이 끼워진 자리의 앞뒤 줄 번호 */
  insertionSpots: number[];
}

const OMIT_NOTE = '<!-- 파일이 커서 생략했습니다';

/** git이 따옴표로 감싼 경로("...", C 이스케이프와 8진수 바이트)를 푼다. 따옴표가 없으면 그대로 */
function unquoteGitPath(text: string): string {
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text;
  const body = text.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else if (next in simple) {
      bytes.push(simple[next]!);
      i += 1;
    } else bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripSidePrefix(text: string, side: 'a' | 'b'): string {
  return text.startsWith(`${side}/`) ? text.slice(2) : text;
}

function headerPaths(line: string): { oldPath?: string; newPath?: string } {
  const rest = line.slice('diff --git '.length);
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) return { oldPath: stripSidePrefix(unquoteGitPath(quoted[1]!), 'a'), newPath: stripSidePrefix(unquoteGitPath(quoted[2]!), 'b') };
  const plain = /^a\/(.+?) b\/(.+)$/.exec(rest);
  if (plain) return { oldPath: plain[1], newPath: plain[2] };
  return {};
}

function fileLinePath(line: string, marker: '--- ' | '+++ ', side: 'a' | 'b'): string | null | undefined {
  if (!line.startsWith(marker)) return undefined;
  const raw = line.slice(marker.length).replace(/\t.*$/, '');
  if (raw === '/dev/null') return null;
  return stripSidePrefix(unquoteGitPath(raw), side);
}

function parseSections(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let section: DiffSection | undefined;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      section = { ...headerPaths(line), omitted: false, binary: false, added: [], deletionSpots: [], deleted: [], insertionSpots: [] };
      sections.push(section);
      inHunk = false;
      continue;
    }
    if (!section) continue;
    if (line.startsWith(OMIT_NOTE)) {
      section.omitted = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!inHunk) {
      const oldPath = fileLinePath(line, '--- ', 'a');
      const newPath = fileLinePath(line, '+++ ', 'b');
      if (oldPath !== undefined) section.oldPath = oldPath ?? undefined;
      if (newPath !== undefined) section.newPath = newPath ?? undefined;
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) section.binary = true;
      continue;
    }
    if (line.startsWith('+')) {
      section.added.push(newLine);
      section.insertionSpots.push(oldLine - 1, oldLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      section.deleted.push(oldLine);
      section.deletionSpots.push(newLine - 1, newLine);
      oldLine += 1;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      oldLine += 1;
      newLine += 1;
    }
  }
  return sections;
}

/** 보이지 않는 글자(제어·서식 문자)를 뺀다 */
function stripInvisible(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, '');
}

function slashes(text: string): string {
  return text.replace(/\\/g, '/');
}

/** 정확한 비교용: 정규화(NFC)·구분자·"./"·겹친 "/"만 고친 조각들. 읽을 수 없는 경로면 undefined */
function exactSegments(raw: string): string[] | undefined {
  const text = slashes(raw.normalize('NFC'));
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return undefined;
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return undefined;
  return segments;
}

function looseKey(raw: string): string {
  return slashes(stripInvisible(raw).normalize('NFKC'))
    .toLowerCase()
    .split('/')
    .map((segment) => segment.replace(/[. ]+$/, ''))
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

type Resolved = { kind: 'ok'; section: DiffSection } | { kind: 'none' } | { kind: 'bad' };

/** 지적의 파일 이름에 맞는 구간을 찾는다. names는 구간이 가진 이름(보는 쪽이 정한다) */
function resolveSection(sections: readonly DiffSection[], names: (section: DiffSection) => string | undefined, file: string): Resolved {
  const visible = stripInvisible(file).trim();
  if (visible === '') return { kind: 'bad' };
  const segments = exactSegments(visible);
  if (!segments) return { kind: 'bad' };
  const variants = [segments.join('/')];
  if (segments.length > 1 && (segments[0] === 'a' || segments[0] === 'b')) variants.push(segments.slice(1).join('/'));
  const named = sections.flatMap((section) => {
    const name = names(section);
    return name === undefined ? [] : [{ section, exact: exactSegments(name)?.join('/'), loose: looseKey(name) }];
  });
  for (const variant of variants) {
    const exact = named.filter((entry) => entry.exact === variant);
    if (exact.length === 1) return { kind: 'ok', section: exact[0]!.section };
    if (exact.length > 1) return { kind: 'bad' };
    const loose = named.filter((entry) => entry.loose === looseKey(variant));
    if (loose.length === 1) return { kind: 'ok', section: loose[0]!.section };
    if (loose.length > 1) return { kind: 'bad' };
  }
  return { kind: 'none' };
}

function near(spots: readonly number[], line: number, tolerance: number): boolean {
  return spots.some((spot) => Math.abs(spot - line) <= tolerance);
}

/** 지적마다 리뷰어가 받은 diff와 대조한다. 결과는 findings와 같은 순서다 */
export function checkFindingLocations(findings: readonly Located[], reviewed: Pick<TruncatedDiff, 'diff' | 'truncated' | 'omittedFiles'>): FindingLocationCheck[] {
  const sections = parseSections(reviewed.diff);
  // 생략한 파일 목록 없이 잘렸다면 뒷부분이 통째로 사라졌을 수 있어 못 찾은 것을 "없음"이라고 말할 수 없다
  const tailCut = reviewed.truncated && reviewed.omittedFiles.length === 0;
  return findings.map((finding): FindingLocationCheck => {
    const found = resolveSection(sections, (section) => section.newPath ?? section.oldPath, typeof finding.file === 'string' ? finding.file : '');
    if (found.kind === 'bad') return { status: 'unverified', reason: 'bad_location' };
    if (found.kind === 'none') return tailCut ? { status: 'unverified', reason: 'diff_truncated' } : { status: 'not_in_diff', reason: 'file_missing' };
    const section = found.section;
    if (section.omitted) return { status: 'unverified', reason: 'file_omitted' };
    const line = finding.line;
    if (line === undefined) return { status: 'in_diff' };
    if (!Number.isInteger(line) || line < 1) return { status: 'unverified', reason: 'bad_location' };
    if (section.binary) return { status: 'unverified', reason: 'binary' };
    if (near(section.added, line, FINDING_LINE_CONTEXT) || near(section.deletionSpots, line, FINDING_LINE_CONTEXT) || near(section.deleted, line, FINDING_LINE_CONTEXT)) {
      return { status: 'in_diff' };
    }
    return tailCut ? { status: 'unverified', reason: 'diff_truncated' } : { status: 'not_in_diff', reason: 'line_outside' };
  });
}

/**
 * 지적마다 리뷰 이후의 diff에서 바뀌었는지 센다. later는 그 라운드가 본 끝 커밋부터 지금 HEAD까지의 diff(읽지 못했으면 undefined).
 * checks는 같은 지적의 위치 대조 결과(없는 것은 undefined) — in_diff가 아니면 어디를 가리키는지 몰라 모름이다.
 */
export function checkFindingsAddressed(findings: readonly Located[], checks: ReadonlyArray<FindingLocationCheck | undefined>, later: string | undefined): FindingAddressStatus[] {
  const sections = later === undefined ? [] : parseSections(later);
  return findings.map((finding, index): FindingAddressStatus => {
    if (later === undefined || checks[index]?.status !== 'in_diff') return 'unknown';
    // 리뷰한 시점의 파일 이름은 이후 diff의 옛 이름이다
    const found = resolveSection(sections, (section) => section.oldPath, typeof finding.file === 'string' ? finding.file : '');
    if (found.kind === 'bad') return 'unknown';
    if (found.kind === 'none') return 'not_addressed';
    const section = found.section;
    const line = finding.line;
    if (line === undefined) return 'addressed';
    if (section.binary) return 'unknown';
    return section.deleted.includes(line) || section.insertionSpots.includes(line) ? 'addressed' : 'not_addressed';
  });
}

export interface AddressRate {
  addressed: number;
  notAddressed: number;
  unknown: number;
  /** 반영됨/(반영됨+반영 안 됨). 센 것이 없으면 undefined(모름) */
  rate: number | undefined;
}

/** 지적이 있는데 처리 기록(addressed)이 없는 라운드(리뷰 이후 diff를 아직 못 봤거나 옛 기록)는 지적마다 모름으로 센다 */
export function summarizeAddressRate(rounds: ReadonlyArray<{ findings?: readonly unknown[]; addressed?: readonly FindingAddressStatus[] }>): AddressRate {
  let addressed = 0;
  let notAddressed = 0;
  let unknown = 0;
  for (const round of rounds) {
    if (!round.addressed) unknown += round.findings?.length ?? 0;
    for (const status of round.addressed ?? []) {
      if (status === 'addressed') addressed += 1;
      else if (status === 'not_addressed') notAddressed += 1;
      else unknown += 1;
    }
  }
  const counted = addressed + notAddressed;
  return { addressed, notAddressed, unknown, rate: counted === 0 ? undefined : addressed / counted };
}

/** 지적에서 끼워 넣는 글(제목 등)을 마크다운에서 글자 그대로 보이게 한다: 줄바꿈·제어 문자는 공백, 길이 제한, 링크·멘션·이슈 번호·HTML·강조 기호 무력화 */
export function escapeMarkdownText(text: string, maxChars = 200): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  const clipped = chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : flat;
  return clipped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/#/g, '&#35;')
    .replace(/@/g, '&#64;')
    .replace(/`/g, '&#96;')
    .replace(/[\\*_[\]()|~!]/g, (ch) => `\\${ch}`);
}

/** 파일 이름 같은 값을 코드 조각으로 감싼다. 안에 든 백틱보다 긴 울타리를 써서 깨지지 않고, 코드 조각 안에서는 링크·멘션이 동작하지 않는다 */
export function inlineCodeSpan(text: string, maxChars = 200): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  const clipped = chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : flat;
  const longest = Math.max(0, ...(clipped.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = clipped.startsWith('`') || clipped.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clipped}${pad}${fence}`;
}

const REASON_TEXT: Record<FindingLocationReason, string> = {
  file_missing: '지적한 파일이 리뷰한 diff에 없습니다',
  line_outside: `지적한 줄이 바뀐 곳에서 ${FINDING_LINE_CONTEXT}줄을 넘게 떨어져 있습니다`,
  file_omitted: '크기 때문에 그 파일 본문을 생략하고 리뷰해 맞춰 볼 수 없습니다',
  diff_truncated: 'diff 뒷부분이 잘려 맞춰 볼 수 없습니다',
  bad_location: '파일 경로를 읽지 못했거나 어느 파일인지 정할 수 없습니다',
  binary: '바이너리 파일이라 줄을 맞춰 볼 수 없습니다',
};

export function describeLocationCheck(check: FindingLocationCheck): string {
  const label = check.status === 'not_in_diff' ? 'diff에 없음' : check.status === 'unverified' ? '확인 못 함' : 'diff 안';
  return check.reason ? `${label}(${REASON_TEXT[check.reason]})` : label;
}

/**
 * PR 코멘트에 붙이는 "지적 위치 대조" 절. 표시할 것(diff에 없음·확인 못 함)이나 이전 라운드 처리율이 없으면 빈 글자.
 * 이 절은 표시일 뿐 리뷰의 판정은 바꾸지 않는다고 적는다
 */
export function buildReviewCheckNote({
  findings,
  checks,
  previousRounds = [],
}: {
  findings: ReadonlyArray<Pick<PrReviewFinding, 'file' | 'title'> & { line?: number }>;
  checks: ReadonlyArray<FindingLocationCheck | undefined>;
  previousRounds?: ReadonlyArray<{ findings?: readonly unknown[]; addressed?: readonly FindingAddressStatus[] }>;
}): string {
  const marked: string[] = [];
  findings.forEach((finding, index) => {
    const check = checks[index];
    if (!check || check.status === 'in_diff') return;
    const where = inlineCodeSpan(`${finding.file}${finding.line ? `:${finding.line}` : ''}`);
    marked.push(`- ${where} ${escapeMarkdownText(finding.title, 120)} — ${describeLocationCheck(check)}`);
  });
  const rate = summarizeAddressRate(previousRounds);
  const counted = rate.addressed + rate.notAddressed;
  const total = counted + rate.unknown;
  if (marked.length === 0 && total === 0) return '';
  const lines = ['### 지적 위치 대조', '', '리뷰한 diff와 기계로 맞춰 본 표시입니다. 리뷰의 판정(막는지 여부)은 바꾸지 않습니다.'];
  if (marked.length > 0) lines.push('', ...marked);
  if (total > 0) {
    const text =
      counted === 0
        ? `이전 라운드 지적 처리율: 모름 (센 수 없음 ${rate.unknown}건)`
        : `이전 라운드 지적 처리율: ${rate.addressed}/${counted}${rate.unknown > 0 ? ` (모름 ${rate.unknown})` : ''}`;
    lines.push('', text, '(처리율은 지적한 줄이 이후 변경에서 바뀐 비율입니다. 바뀐 것이 지적을 실제로 고쳤는지는 보지 않습니다.)');
  }
  return lines.join('\n');
}
