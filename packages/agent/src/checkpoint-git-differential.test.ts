import { appendFileSync } from 'node:fs';
import { decodeNative, encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { legacy } from './checkpoint-git-legacy';
import { gitEnvFrom, isIndexLockFailure, redactCredentials, stagedMismatchOf } from './checkpoints';
import { Gen, outcome, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';

/**
 * 체크포인트의 git 출력 판정을 Rust로 옮기면서(ADR-191 3s) 옛 TS 구현을 `checkpoint-git-legacy.ts`에 그대로 두고, 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어
 * 결과를 JSON 글자로 견준다. `legacy`는 옮기기 전 `checkpoints.ts`의 해당 함수 본문이다(메서드 안의 인라인 논리는 입력을 인자로 받게 뺐다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 의도한 차이(각 시험의 `allowed`가 이유를 가린다): ① 위험한 설정 키 가운데의 `\r`·U+2028·U+2029(옛 정규식 `.`이 못 맞춤)는 이제 막는다,
 * ② `.git/info/attributes`의 줄은 git이 건너뛰는 글자(` \t\r\n`)만 건너뛴다(옛 JS `trim`은 NBSP·BOM·`\v`·`\f`도 지워 주석으로 읽었다),
 * ③ 짝 없는 서로게이트는 경계에서 U+FFFD(`sameOutcome`이 양쪽을 같은 규칙으로 맞춘다). 열린 쪽(막던 것을 통과시킴) 뒤집힘은 0이어야 한다.
 *
 * 크기는 환경 변수로 바꾼다: CHECKPOINT_GIT_DIFF_SEEDS(쉼표 목록), CHECKPOINT_GIT_DIFF_ITERATIONS, CHECKPOINT_GIT_DIFF_REPORT=<파일 경로>(분포를 그 파일에 덧붙인다)
 */

const SEEDS = readEnvList('CHECKPOINT_GIT_DIFF_SEEDS', [1, 2, 3]);
const ITERATIONS = readEnvNumber('CHECKPOINT_GIT_DIFF_ITERATIONS', 1500);
const REPORT = process.env.CHECKPOINT_GIT_DIFF_REPORT;

const LINE_ENDS = /[\r\u2028\u2029]/;
const WS_NOT_BLANK = /[\u00a0\ufeff\v\f\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

interface Stats {
  cases: number;
  different: number;
  allowedDifferent: number;
  /** 의도한 차이 중 옛 쪽이 통과시키던 것을 새 쪽이 막은 수(막는 쪽으로만 달라진다) */
  tightened: number;
  opened: number;
  distribution: Record<string, number>;
}

/**
 * 같은 입력을 옛 구현과 새 껍데기에 넣어 견준다. allowed(input, legacy, current)가 참인 차이는 의도한 차이로 센다. opened(legacy, current)가 참이면 열린 쪽 뒤집힘이다.
 */
function compare<I>(
  name: string,
  generate: (g: Gen) => I,
  oldImpl: (input: I) => unknown,
  newImpl: (input: I) => unknown,
  classify: (legacyValue: Outcome, current: Outcome, input: I) => string,
  { allowed = () => false, opened = () => false, strict = false }: { allowed?: (input: I, a: Outcome, b: Outcome) => boolean; opened?: (a: Outcome, b: Outcome) => boolean; strict?: boolean } = {},
): Stats {
  const stats: Stats = { cases: 0, different: 0, allowedDifferent: 0, tightened: 0, opened: 0, distribution: {} };
  const failures: string[] = [];
  for (const seed of SEEDS) {
    const g = new Gen(seed);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = generate(g);
      const a = outcome(() => oldImpl(input));
      const b = outcome(() => newImpl(input));
      stats.cases++;
      const label = classify(a, b, input);
      stats.distribution[label] = (stats.distribution[label] ?? 0) + 1;
      if (opened(a, b)) stats.opened++;
      if (!sameOutcome(a, b)) {
        // 의도한 차이 ③: 옛 결과에 짝 없는 서로게이트가 있으면(자르다가 쌍을 가른 경우) 경계에서 U+FFFD가 되어 글자와 정렬 자리가 다르다. strict면 이 예외도 두지 않는다
        if (allowed(input, a, b) || (!strict && hasLone(a))) {
          stats.allowedDifferent++;
          if (!a.threw && !b.threw && Array.isArray(a.value) && Array.isArray(b.value) && b.value.length > a.value.length) stats.tightened++;
        }
        else {
          stats.different++;
          if (failures.length < 3) failures.push(`${name} seed=${seed} i=${i}\n입력 ${JSON.stringify(input)}\n옛 ${JSON.stringify(a)}\n새 ${JSON.stringify(b)}`);
        }
      }
    }
  }
  const line = `${name}: ${JSON.stringify(stats)}`;
  if (REPORT) appendFileSync(REPORT, `${line}\n`);
  if (failures.length > 0) throw new Error(`${line}\n${failures.join('\n---\n')}`);
  return stats;
}

const LONE_UNIT = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
function containsLone(value: unknown): boolean {
  if (typeof value === 'string') return LONE_UNIT.test(value);
  if (Array.isArray(value)) return value.some(containsLone);
  if (value !== null && typeof value === 'object') return Object.entries(value).some(([key, item]) => LONE_UNIT.test(key) || containsLone(item));
  return false;
}
const hasLone = (o: Outcome) => !o.threw && containsLone(o.value);
const valueOf = (o: Outcome) => (o.threw ? undefined : o.value);

// ── 무작위 입력 ──────────────────────────────────────────────────────────

const ASTRAL = '😀';
const NAME_PARTS = ['a', 'b', 'src', 'lib', 'x y', 'é', '가', ASTRAL, '\ufffd', '\ue010', '\ue011', '\ue000', 'A', '..', '-', '.git', 'tab\there', 'ſ', '\u212a', 'i\u0307', '\u0130'];
const LONE = ['\ud800', '\udbff', '\udc00', '\udfff', '\ud83d', '\ude00'];

function name(g: Gen, withLone = false): string {
  const parts = g.list(1, 3, () => (withLone && g.chance(0.15) ? g.pick(LONE) : g.pick(NAME_PARTS)));
  return parts.join(g.pick(['', '/', '/']));
}

function randomCase(g: Gen, text: string): string {
  return [...text].map((c) => (g.chance(0.3) ? (g.chance(0.5) ? c.toUpperCase() : c.toLowerCase()) : c)).join('');
}

const SECTIONS = ['url', 'http', 'remote', 'diff', 'merge', 'core', 'include', 'includeif', 'credential', 'protocol', 'filter', 'gpg', 'commit', 'tag', 'user', 'branch', 'init', 'receive'];
const SUBS = ['', 'origin', 'https://x/', 'a.b', 'x\ry', 'x\u2028y', 'x\u2029y', '\r', 'lfs', 'é', ASTRAL, '.', 'a b'];
const VARS = [
  'insteadof', 'pushinsteadof', 'proxy', 'pushurl', 'receivepack', 'uploadpack', 'vcs', 'textconv', 'command', 'driver', 'extraheader', 'sslverify', 'cookiefile', 'worktree',
  'sshcommand', 'gitproxy', 'askpass', 'external', 'gpgsign', 'path', 'program', 'clean', 'name', 'email', 'url', 'fetch', 'hookspath', 'allow',
];
const SCOPES = ['local', 'local', 'local', 'worktree', 'global', 'system', 'command', 'Local', ''];
const VALUES = ['', 'true', 'false', ' False ', 'no', 'OFF', '0', '00', 'x', 'yes', '1', 'a\nb', '\u00a0false', '\ufefffalse', 'fals', 'false\u2028', 'No\n'];

function configKey(g: Gen): string {
  const parts: string[] = [g.pick(SECTIONS)];
  if (g.chance(0.8)) parts.push(g.pick(SUBS));
  parts.push(g.pick(VARS));
  let key = parts.join('.');
  if (g.chance(0.15)) key = key.slice(0, key.length - 1 - g.int(3));
  if (g.chance(0.1)) key += g.pick(['x', '.', '\r', 'foo']);
  if (g.chance(0.1)) key = `${g.pick(['x', ' ', '.'])}${key}`;
  return g.chance(0.3) ? randomCase(g, key) : key;
}

interface ConfigCase {
  output: string;
  separate: boolean;
}

function configCase(g: Gen): ConfigCase {
  const entries = g.list(0, 6, () => {
    const key = configKey(g);
    const value = g.chance(0.15) ? undefined : g.pick(VALUES);
    return [g.pick(SCOPES), 'file:.git/config', value === undefined ? key : `${key}\n${value}`] as const;
  });
  let fields = entries.flat();
  const damage = g.int(20);
  if (damage === 0) fields = fields.slice(0, -1);
  else if (damage === 1) fields = [...fields, 'extra'];
  const tail = g.chance(0.9) ? '\0' : '';
  return { output: fields.length === 0 ? '' : fields.join('\0') + tail, separate: g.chance(0.4) };
}

function attributesCase(g: Gen): string {
  const lines = g.list(0, 6, () =>
    g.weighted<string>([
      [3, ''],
      [3, g.pick(['#', '# 주석', '  # x', '\t#', '# * filter=x'])],
      [3, g.pick(['* filter=x', '*.txt export-ignore', 'a export-subst', '  * diff=x', '\t* text', '*'])],
      [2, g.pick(['\u00a0# * export-ignore', '\ufeff# c', '\v# c', '\f* x', '\u2003', '\u00a0', '\u3000* filter=x', ' \u00a0# x'])],
      [1, g.pick([' ', '\t', '\r', ' \r', '* x\r'])],
    ]),
  );
  return lines.join(g.pick(['\n', '\n', '\r\n'])) + (g.chance(0.5) ? '\n' : '');
}

const STATUS = ['??', ' M', 'M ', 'A ', ' D', 'D ', 'R ', 'C ', 'RM', 'AD', 'MM', 'UU', '!!', ' T', 'DD', 'AM', 'CM'];

function porcelainCase(g: Gen): { output: string; subdir: string } {
  const subdir = g.pick(['', '', 'src', 'a/b']);
  const prefixed = () => (subdir && g.chance(0.7) ? `${subdir}/${name(g)}` : name(g));
  const entries = g.list(0, 8, () => {
    const code = g.chance(0.95) ? g.pick(STATUS) : g.pick(['', 'A', '😀', 'A😀', '??x', 'R']);
    const base = g.chance(0.9) ? ' ' : '';
    const entry = `${code}${base}${prefixed()}`;
    return /^[RC]/.test(code) && g.chance(0.9) ? [entry, prefixed()] : [entry];
  });
  const flat = entries.flat();
  if (g.chance(0.1) && flat.length > 0) flat.push(flat[g.int(flat.length)]!);
  if (g.chance(0.05)) flat.splice(g.int(flat.length + 1), 0, '');
  return { output: flat.join('\0') + (g.chance(0.9) ? '\0' : ''), subdir };
}

const NUM_TOKENS = ['0', '1', '7', '12', '300', '-', '', ' 5', '5 ', '0x10', '1e3', 'Infinity', '-Infinity', '1_0', 'abc', '-5', '+3', '0b11', '0o7', '.5', '1.5', '00', '-0', '१', '9007199254740993', '1e400', '\u00a07'];

function numstatCase(g: Gen): string {
  return g
    .list(0, 6, () => g.list(1, 4, () => (g.chance(0.85) ? g.pick(NUM_TOKENS) : name(g))).join('\t'))
    .join(g.chance(0.9) ? '\n' : '\r\n');
}

const OURS = 'checkpoints@b-studio.local';
const EMAILS = [OURS, ` ${OURS} `, 'CHECKPOINTS@B-STUDIO.LOCAL', 'chec\u212apoints@b-studio.local', `x${OURS}`, `${OURS}x`, 'checkpoints@b-studio.loca1', '', ' ', 'a@b.c', `${OURS}\n`, `\u00a0${OURS}`, `\ufeff${OURS}`, 'checkpoints@b-studio.\u0130ocal', 'chec\ue011\ue000\ue000', '\ue010\ue00d\ue008\ue000'];

function recordFields(g: Gen, withCreated: boolean): string[] {
  const trailers = () => g.list(0, 3, () => g.pick(['a', 'b, c', 'none', '', ' x ', 'docs'])).join('\x1f');
  const fields = [
    g.pick(['', 'abc123', 'f'.repeat(40)]),
    g.pick(['', 'abc1234']),
    g.pick(['', '제목', 'feat: x', ' 공백 ']),
    ...(withCreated ? [g.pick(['', '2026-11-10T00:00:00+09:00'])] : [g.pick(['', '본문\n둘째', ' 앞뒤 \n', '\u00a0x\u00a0'])]),
    g.pick(EMAILS),
    trailers(),
    trailers(),
    trailers(),
  ];
  if (!withCreated) return fields;
  return fields;
}

function sessionCase(g: Gen): { output: string; ours: string } {
  const records = g.list(0, 4, () => {
    const fields = recordFields(g, false);
    const cut = g.chance(0.15) ? g.int(fields.length + 1) : fields.length;
    return fields.slice(0, cut).join('\0') + (g.chance(0.1) ? '\0extra' : '');
  });
  const output = records.map((r) => (g.chance(0.5) ? `\n${r}` : r)).join('\x1e') + (g.chance(0.8) ? '\x1e' : '') + (g.chance(0.3) ? '\n' : '');
  return { output, ours: g.pick([OURS, ` ${OURS.toUpperCase()} `, 'other@x.y', ''] ) };
}

function showCase(g: Gen): { output: string; ours: string } {
  const fields = recordFields(g, true);
  const cut = g.chance(0.15) ? g.int(fields.length + 1) : fields.length;
  const text = fields.slice(0, cut).join('\0');
  return { output: `${g.chance(0.5) ? '\n ' : ''}${text}${g.pick(['', '\n', ' \n'])}`, ours: g.pick([OURS, ` ${OURS.toUpperCase()} `, 'other@x.y', '']) };
}

function remoteCase(g: Gen): string {
  const records = g.list(0, 4, () => g.list(0, 5, () => g.pick(['abc', '제목', '', 'x y', ASTRAL, 'Name <e>'])).join('\0'));
  return records.map((r) => (g.chance(0.5) ? `\n${r}` : r)).join('\x1e') + (g.chance(0.8) ? '\x1e\n' : '');
}

const SPACE = [' ', '  ', '\t', '\n', '\r\n', '\u00a0', '\u2028', '\ufeff', '\u3000', '\v', '\f', '\u0085', '\u200b', '\n\n\n'];
const WORDS = ['제목', 'feat', 'x', '가나다', ASTRAL, 'é', 'Workflow-Passed: a, b', '# 주석', '\ufffd'];

function text(g: Gen, max: number): string {
  return g.list(0, max, () => (g.chance(0.4) ? g.pick(SPACE) : g.pick(WORDS))).join(g.pick(['', ' ']));
}

function longText(g: Gen): string {
  const base = text(g, 8);
  if (g.chance(0.15)) return `${'가'.repeat(110 + g.int(20))}${g.pick([ASTRAL, 'x', ' ', ASTRAL.repeat(3)])}${base}`;
  if (g.chance(0.05)) return `${g.pick(['x', ASTRAL, '가']).repeat(7990 + g.int(30))}${base}`;
  return base;
}

function credentialText(g: Gen): string {
  const tokens = ['https://', 'ssh://', 'git+ssh://', 'x', 'tok', 'user:pw', '@', '/', ' ', ':', '9', '_', '.', '+', '-', '\u00a0', 'é', ASTRAL, 'ſ', '\u212a', 'HTTP://', 'a://', '://', "'", '\n', '\t', 'fatal: ', 'github.com', '\ufeff', 'https://tok@h/x', 'ssh://u:p@h', 'x://y@z', 'http://@h', 'https://a/b@c', "'git+ssh://tk@", 'https://', 'tok@'];
  return g.list(1, 12, () => g.pick(tokens)).join(g.pick(['', '', ' ']));
}

function lockText(g: Gen): string {
  const tokens = ['index.lock', 'INDEX.LOCK', 'index_lock', 'File exists', 'FILE EXISTS', 'file Exists', 'Unable to create', 'unable TO create', 'Another git process', 'another  git process', 'x', '\n', "'", ' ', 'ſ', 'Fıle'];
  return g.list(0, 5, () => g.pick(tokens)).join(g.pick(['', ' ']));
}

function wordCase(g: Gen): string {
  const letters = ['a', 'e', 'i', 'o', 'u', 'b', 'z', 'A', 'E', 'I', 'O', 'U', 'İ', '\u212a', 'ß', 'ǅ', 'é', 'ä', '가', ASTRAL, ' ', '\u00a0', '\ufeff', '\ud800', '\udc00', '1', '-', 'ı', 'ſ'];
  return g.list(0, 5, () => g.pick(letters)).join('');
}

function dotGitName(g: Gen): string {
  const variants = ['.git', '.GIT', '.Git', '.gIt', '.gıt', '.git ', ' .git', 'git', '.git\0', '.İt', '.g\u0131t', '.\u212ait', '.gi', '.gitt', '..git', '.git.', '.GİT', '.gİt', ''];
  return g.chance(0.7) ? g.pick(variants) : randomCase(g, g.pick(variants));
}

function idText(g: Gen, alphabet: string[], minLen: number, maxLen: number): string {
  const edge = g.pick([minLen - 1, minLen, minLen + 1, maxLen - 1, maxLen, maxLen + 1, g.int(maxLen + 5)]);
  const chars = Array.from({ length: Math.max(0, edge) }, () => g.pick(alphabet));
  if (g.chance(0.3) && chars.length > 0) chars[g.int(chars.length)] = g.pick(['g', 'A', '\n', ' ', '-', '_', '.', 'é', '\ufeff', '/', 'F', 'Z']);
  return chars.join('') + (g.chance(0.1) ? g.pick(['\n', ' ', 'x']) : '');
}

function targetCase(g: Gen): { listed: string; baseRef: string; infoBase: string } {
  const infoBase = g.pick(['main', 'release/1', 'x y', 'é']);
  const baseRef = `refs/heads/${g.chance(0.9) ? infoBase : 'other'}`;
  const branch = g.pick(['trunk', 'main', 'a/b', 'x y', '', 'é', 'a\u00a0b', 'dev\tx']);
  const lines = g.list(0, 4, () =>
    g.pick([
      `ref: refs/heads/${branch}\tHEAD`,
      `ref: refs/heads/${branch} HEAD`,
      `ref: refs/heads/${branch}\tHEADx`,
      ` ref: refs/heads/${branch}\tHEAD \r`,
      `ref: refs/tags/${branch}\tHEAD`,
      `ref: refs/heads/${branch}\tHEAD\textra`,
      'ref: ',
      'ref:refs/heads/x\tHEAD',
      'a1b2c3\tHEAD',
      `a1b2c3\t${baseRef}`,
      `a1b2c3\t${baseRef}2`,
      `a1b2c3 ${baseRef}`,
      `a1b2c3\tx${baseRef}`,
      `a1b2c3\t${baseRef}\r`,
      '',
    ]),
  );
  return { listed: lines.join(g.pick(['\n', '\r\n'])), baseRef, infoBase };
}

function argsCase(g: Gen): string[] {
  return g.list(0, 6, () => g.pick(['-C', '--git-dir', '--work-tree', '-c', 'status', 'log', 'x', '', '--no-pager', '-c=a', 'é', ASTRAL, '-C ']));
}

function envCase(g: Gen): Record<string, string> {
  const names = ['PATH', 'HOME', 'GIT_DIR', 'git_dir', 'Git_Index_File', 'GIT_AUTHOR_NAME', 'git_author_name', 'GIT_SSH_COMMAND', 'GIT_SSH_COMMAND2', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_SSL_CAINFO', 'GITX', 'GIT', 'GIT_', 'ſGIT_DIR', 'GİT_DIR', 'GIT_\ud800', 'x\udc00', 'GIT_ASKPASS', 'HTTP_PROXY', 'GIT_SSL_NO_VERIFY', 'GIT_TRACE', 'GIT_EXEC_PATH', 'GIT_COMMITTER_DATE', 'GIT_AUTHOR_NAME\ud800'];
  const env: Record<string, string> = {};
  for (const key of g.list(0, 10, () => g.pick(names))) env[key] = g.pick(['1', 'x', '']);
  return env;
}

function stagedCase(g: Gen): { ls: string; staged: string; subdir: string; expected: Map<string, string> } {
  const subdir = g.pick(['', '', 'src', 'a/b', '\ue010']);
  const universe = [...new Set(g.list(1, 7, () => name(g)))];
  const inside = (file: string) => (subdir ? `${subdir}/${file}` : file);
  const rootPath = (file: string) => (subdir && g.chance(0.15) ? `other/${file}` : inside(file));
  const ids = ['aaa', 'bbb', 'c0ffee', 'undefined', ''];
  const consistent = g.chance(0.55);
  const lsEntries: string[] = [];
  const stagedNames: string[] = [];
  const expected = new Map<string, string>();
  for (const file of universe) {
    const staged = g.chance(0.7);
    const path = consistent ? inside(file) : rootPath(file);
    const mode = g.pick(['100644', '100755', '120000', '160000', '100644']);
    const id = g.pick(ids);
    const hasEntry = g.chance(0.75);
    if (staged) stagedNames.push(path);
    if (hasEntry) {
      const stage = !consistent && g.chance(0.1) ? g.pick(['100644', '', '120000 x', '100644  0']) : `${mode} ${id} 0`;
      lsEntries.push(!consistent && g.chance(0.05) ? g.pick([`${stage}${path}`, stage]) : `${stage}\t${path}`);
    }
    if (consistent) {
      if (staged) expected.set(file, hasEntry ? (mode === '120000' ? 'link:' : mode === '160000' ? 'other' : `blob:${id}`) : 'missing');
    } else if (g.chance(0.7)) {
      const key = g.chance(0.1) ? g.pick(LONE) + file : file;
      expected.set(key, g.pick(['blob:aaa', 'blob:bbb', 'blob:c0ffee', 'blob:undefined', 'link:', 'link:x', 'other', 'missing', 'blob:', '\ud800', '\ue010']));
    }
  }
  if (consistent && g.chance(0.3)) expected.set(g.pick(LONE) + g.pick(universe), 'missing');
  if (consistent && g.chance(0.2) && expected.size > 0) expected.set([...expected.keys()][0]!, 'blob:zzz');
  if (g.chance(0.2)) expected.set(g.pick(LONE), 'missing');
  return { ls: lsEntries.join('\0') + (g.chance(0.9) ? '\0' : ''), staged: stagedNames.join('\0') + (g.chance(0.9) ? '\0' : ''), subdir, expected };
}

// ── 시험 ─────────────────────────────────────────────────────────────────

const classifyBool = (a: Outcome, b: Outcome) => `${valueOf(a) ? '참' : '거짓'}/${valueOf(b) ? '참' : '거짓'}`;
const classifyList = (a: Outcome) => (a.threw ? '던짐' : Array.isArray(a.value) ? (a.value.length === 0 ? '빈 결과' : '값') : '값');

describe('checkpoints git 출력 판정: 옛 TS와 Rust 껍데기', () => {
  it('위험한 로컬 설정: 막는 쪽 — 열린 쪽 뒤집힘 0, 줄 끝 글자 키만 더 막는다', () => {
    const stats = compare(
      'dangerousLocalConfig',
      configCase,
      ({ output, separate }) => legacy.dangerousLocalConfig(output, separate),
      ({ output, separate }) => native.checkpointDangerousLocalConfig(output, separate) ?? undefined,
      (a) => (valueOf(a) === undefined ? '읽지 못함' : (valueOf(a) as string[]).length > 0 ? '막음' : '통과'),
      {
        // 의도한 차이: 옛 정규식이 못 맞춘 줄 끝 글자 키만 더 막는다(옛 결과가 새 결과의 부분 목록이고, 입력에 그 글자가 있다)
        allowed: ({ output }, a, b) => {
          const before = valueOf(a) as string[] | undefined;
          const after = valueOf(b) as string[] | undefined;
          return !!before && !!after && LINE_ENDS.test(output) && after.length > before.length && before.every((line) => after.includes(line));
        },
        opened: (a, b) => {
          const before = valueOf(a) as string[] | undefined;
          const after = valueOf(b) as string[] | undefined;
          return !!before && before.length > 0 && !!after && before.some((line) => !after.includes(line));
        },
      },
    );
    expect(stats.opened).toBe(0);
    expect(stats.tightened).toBeGreaterThan(0);
    expect(stats.distribution['막음']).toBeGreaterThan(stats.cases / 10);
    expect(stats.distribution['통과']).toBeGreaterThan(stats.cases / 10);
    expect(stats.distribution['읽지 못함']).toBeGreaterThan(0);
  });

  it('.git/info/attributes: 막는 쪽 — 열린 쪽 뒤집힘 0, git이 읽는 규칙으로 더 막는다', () => {
    const stats = compare(
      'infoAttributes',
      attributesCase,
      (input) => legacy.infoAttributes(input),
      (input) => native.checkpointInfoAttributes(input),
      (a) => ((valueOf(a) as string[]).length > 0 ? '막음' : '통과'),
      {
        // 의도한 차이: JS trim이 지우지만 git은 건너뛰지 않는 글자가 든 줄을 더 센다. 옛 쪽이 막았으면 새 쪽도 막아야 한다
        allowed: (input, a, b) => WS_NOT_BLANK.test(input) && (valueOf(b) as string[]).length > 0,
        opened: (a, b) => (valueOf(a) as string[]).length > 0 && (valueOf(b) as string[]).length === 0,
      },
    );
    expect(stats.opened).toBe(0);
    expect(stats.distribution['막음']).toBeGreaterThan(stats.cases / 10);
    expect(stats.distribution['통과']).toBeGreaterThan(stats.cases / 10);
  });

  it('스테이지 불일치: 막는 쪽 — 짝 없는 서로게이트가 든 경로까지 옛 구현과 완전히 같다', () => {
    const stats = compare(
      'stagedMismatch',
      stagedCase,
      ({ ls, staged, subdir, expected }) => legacy.stagedMismatch(ls, staged, subdir, expected),
      ({ ls, staged, subdir, expected }) => stagedMismatchOf(ls, staged, subdir, expected),
      (a) => (a.threw ? '던짐' : (a.value as string[]).length === 0 ? '일치' : '불일치'),
      { strict: true, opened: (a, b) => !a.threw && !b.threw && (a.value as string[]).some((file) => !(b.value as string[]).includes(file)) },
    );
    expect(stats.opened).toBe(0);
    expect(stats.distribution['일치']).toBeGreaterThan(stats.cases / 20);
    expect(stats.distribution['불일치']).toBeGreaterThan(stats.cases / 5);
  });

  it('status --porcelain -z: 파일 목록과 종류', () => {
    const files = compare(
      'pendingFiles',
      porcelainCase,
      ({ output, subdir }) => legacy.pendingFiles(output, subdir),
      ({ output, subdir }) => native.checkpointPendingFiles(output, subdir).sort(),
      classifyList,
    );
    expect(files.distribution['값']).toBeGreaterThan(files.cases / 4);
    const changes = compare(
      'pendingChanges',
      porcelainCase,
      ({ output, subdir }) => legacy.pendingChanges(output, subdir),
      ({ output, subdir }) =>
        native
          .checkpointPendingChanges(output, subdir)
          .map(([file, change]) => ({ file: file!, change }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      classifyList,
    );
    expect(changes.distribution['값']).toBeGreaterThan(changes.cases / 4);
  });

  it('numstat 합', () => {
    const stats = compare(
      'commitStat',
      numstatCase,
      (input) => legacy.commitStat(input),
      (input) => {
        const [insertions = 0, deletions = 0] = native.checkpointCommitStat(input);
        return { insertions, deletions };
      },
      (a) => (a.threw ? '던짐' : (a.value as { insertions: number }).insertions === 0 ? '0' : '값'),
    );
    expect(stats.distribution['값']).toBeGreaterThan(stats.cases / 4);
  });

  it('레코드 분리와 작성자 비교: 여는 쪽(ours) 뒤집힘 0', () => {
    const remote = compare(
      'remoteCommits',
      remoteCase,
      (input) => legacy.remoteCommits(input),
      (input) => native.checkpointRemoteCommits(input).map(([sha = '', shortSha = '', subject = '', author = '']) => ({ sha, shortSha, subject, author })),
      classifyList,
    );
    expect(remote.distribution['값']).toBeGreaterThan(remote.cases / 4);
    const trueOnly = (a: Outcome, b: Outcome) =>
      !a.threw && !b.threw && (a.value as Array<{ ours: boolean }>).some((record, i) => !record.ours && (b.value as Array<{ ours: boolean }>)[i]?.ours === true);
    const session = compare(
      'sessionRecords',
      sessionCase,
      ({ output, ours }) => legacy.sessionRecords(output, ours),
      ({ output, ours }) => decodeNative(native.checkpointSessionRecords(output, encodeLoneSurrogates(ours))),
      classifyList,
      { opened: trueOnly },
    );
    expect(session.opened).toBe(0);
    expect(session.distribution['값']).toBeGreaterThan(session.cases / 4);
    const show = compare(
      'showRecord',
      showCase,
      ({ output, ours }) => legacy.showRecord(output, ours),
      ({ output, ours }) => decodeNative(native.checkpointShowRecord(output, encodeLoneSurrogates(ours))),
      (a) => (a.threw ? '던짐' : (a.value as { ours: boolean }).ours ? '우리 것' : '남의 것'),
      { opened: (a, b) => !a.threw && !b.threw && !(a.value as { ours: boolean }).ours && (b.value as { ours: boolean }).ours },
    );
    expect(show.opened).toBe(0);
    expect(show.distribution['우리 것']).toBeGreaterThan(show.cases / 20);
    expect(show.distribution['남의 것']).toBeGreaterThan(show.cases / 4);
  });

  it('글자 다듬기와 커밋 메시지', () => {
    const one = compare('oneLine', (g) => longText(g), (input) => legacy.oneLine(input), (input) => native.checkpointOneLine(input), (a) => (valueOf(a) === '체크포인트' ? '빈 값' : '값'));
    expect(one.distribution['값']).toBeGreaterThan(one.cases / 4);
    expect(one.distribution['빈 값']).toBeGreaterThan(0);
    compare('stripSpace', (g) => text(g, 12), (input) => legacy.stripSpace(input), (input) => native.checkpointStripSpace(input), (a) => (valueOf(a) === '' ? '빈 값' : '값'));
    const cap = compare(
      'capText',
      (g) => ({ text: longText(g), max: g.pick([0, 1, 3, 10, 119, 120, 121, 8000]) }),
      ({ text, max }) => legacy.capText(text, max),
      ({ text, max }) => native.checkpointCapText(text, max),
      (a) => (String(valueOf(a)).includes('생략했습니다') ? '잘림' : '그대로'),
    );
    expect(cap.distribution['잘림']).toBeGreaterThan(cap.cases / 20);
    expect(cap.distribution['그대로']).toBeGreaterThan(cap.cases / 4);
    const message = compare(
      'commitMessage',
      (g) => ({ subject: longText(g), body: g.chance(0.3) ? undefined : longText(g), trailers: g.list(0, 3, () => text(g, 4)) }),
      ({ subject, body, trailers }) => legacy.commitMessage(subject, body, trailers),
      ({ subject, body, trailers }) => native.checkpointCommitMessage(subject, body, trailers),
      (a) => (String(valueOf(a)).includes('\n\n') ? '여러 문단' : '한 문단'),
    );
    expect(message.distribution['여러 문단']).toBeGreaterThan(message.cases / 10);
    expect(message.distribution['한 문단']).toBeGreaterThan(message.cases / 20);
  });

  it('subcommand·조사·.git 이름·ID 검사', () => {
    const sub = compare('subcommand', argsCase, (input) => legacy.subcommand(input), (input) => native.checkpointSubcommand(input) ?? undefined, (a) => (valueOf(a) === undefined ? '없음' : '있음'));
    expect(sub.distribution['없음']).toBeGreaterThan(0);
    expect(sub.distribution['있음']).toBeGreaterThan(sub.cases / 4);
    const particle = compare('withObjectParticle', wordCase, (input) => legacy.withObjectParticle(input), (input) => native.checkpointWithObjectParticle(input), (a) => String(valueOf(a)).slice(-1));
    expect(particle.distribution['를']).toBeGreaterThan(particle.cases / 10);
    expect(particle.distribution['을']).toBeGreaterThan(particle.cases / 10);
    const dot = compare('isDotGit', dotGitName, (input) => legacy.isDotGit(input), (input) => native.checkpointIsDotGit(input), classifyBool, {
      opened: (a, b) => valueOf(a) === true && valueOf(b) === false,
    });
    expect(dot.opened).toBe(0);
    expect(dot.distribution['참/참']).toBeGreaterThan(dot.cases / 10);
    expect(dot.distribution['거짓/거짓']).toBeGreaterThan(dot.cases / 10);
    const hex = [...'0123456789abcdef'];
    const sha = compare('isSha', (g) => idText(g, hex, 7, 40), (input) => legacy.isSha(input), (input) => native.checkpointIsSha(input), classifyBool);
    expect(sha.distribution['참/참']).toBeGreaterThan(sha.cases / 10);
    expect(sha.distribution['거짓/거짓']).toBeGreaterThan(sha.cases / 10);
    const word = [...'0123456789abcXYZ-'];
    const backup = compare('isBackupId', (g) => idText(g, word, 10, 64), (input) => legacy.isBackupId(input), (input) => native.checkpointIsBackupId(input), classifyBool);
    expect(backup.distribution['참/참']).toBeGreaterThan(backup.cases / 10);
    expect(backup.distribution['거짓/거짓']).toBeGreaterThan(backup.cases / 10);
  });

  it('자격 증명 가림·인덱스 잠금 판정', () => {
    const redact = compare('redactCredentials', credentialText, (input) => legacy.redactCredentials(input), (input) => redactCredentials(input), (a, _b, input) => (valueOf(a) === input ? '가릴 것 없음' : '가림'));
    expect(redact.distribution['가림']).toBeGreaterThan(redact.cases / 10);
    expect(redact.distribution['가릴 것 없음']).toBeGreaterThan(redact.cases / 10);
    const lock = compare('isIndexLockFailure', lockText, (input) => legacy.isIndexLockFailure(input), (input) => isIndexLockFailure(input), classifyBool);
    expect(lock.distribution['참/참']).toBeGreaterThan(lock.cases / 20);
    expect(lock.distribution['거짓/거짓']).toBeGreaterThan(lock.cases / 4);
  });

  it('pullRequestTarget 출력 읽기와 gitEnv: 막는 쪽 열린 뒤집힘 0', () => {
    const target = compare(
      'pullRequestTarget',
      targetCase,
      ({ listed, baseRef, infoBase }) => legacy.pullRequestTarget(listed, baseRef, infoBase),
      ({ listed, baseRef, infoBase }) => decodeNative(native.checkpointPullRequestTarget(listed, baseRef, infoBase)),
      (a) => (a.threw ? '던짐' : 'missingBase' in (a.value as object) ? '기준 없음' : '기준 있음'),
    );
    expect(target.distribution['기준 없음']).toBeGreaterThan(target.cases / 10);
    expect(target.distribution['기준 있음']).toBeGreaterThan(target.cases / 20);
    const env = compare(
      'gitEnv',
      envCase,
      (input) => Object.keys(legacy.gitEnv(input)).sort(),
      (input) =>
        Object.keys(gitEnvFrom(input))
          .filter((key) => key in input)
          .sort(),
      classifyList,
      // 옛 구현이 지운 키가 새 구현에 남아 있으면 열린 쪽이다(gitEnv가 늘 채우는 키는 입력에 있는 것만 센다)
      { strict: true, opened: (a, b) => !a.threw && !b.threw && (b.value as string[]).some((key) => !(a.value as string[]).includes(key)) },
    );
    expect(env.opened).toBe(0);
  });

  describe('대조 장치: 한 곳을 어긋나게 한 옛 구현은 차이로 잡힌다', () => {
    function detects(mutantImpl: (g: Gen) => { a: unknown; b: unknown }): number {
      let differences = 0;
      for (const seed of SEEDS) {
        const g = new Gen(seed);
        for (let i = 0; i < ITERATIONS; i++) {
          const { a, b } = mutantImpl(g);
          if (!sameOutcome({ threw: false, value: a }, { threw: false, value: b })) differences++;
        }
      }
      return differences;
    }

    it('경계 ±1·한 글자 바꾸기', () => {
      const hex = [...'0123456789abcdef'];
      expect(detects((g) => { const t = idText(g, hex, 7, 40); return { a: /^[0-9a-f]{6,40}$/.test(t), b: native.checkpointIsSha(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = idText(g, hex, 7, 40); return { a: /^[0-9a-f]{7,41}$/.test(t), b: native.checkpointIsSha(t) }; })).toBeGreaterThan(0);
      const word = [...'0123456789abcXYZ-'];
      expect(detects((g) => { const t = idText(g, word, 10, 64); return { a: /^[0-9A-Za-z-]{11,64}$/.test(t), b: native.checkpointIsBackupId(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = idText(g, word, 10, 64); return { a: /^[0-9A-Za-z-]{10,64}/.test(t), b: native.checkpointIsBackupId(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = longText(g); return { a: t.replace(/\s+/g, ' ').trim().slice(0, 121) || '체크포인트', b: native.checkpointOneLine(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = longText(g); const max = g.pick([3, 120, 8000]); return { a: t.length < max ? t : `${t.slice(0, max)}...`, b: native.checkpointCapText(t, max) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = lockText(g); return { a: /index\.lock/i.test(t) && /File exists|Unable to create|Another git process/i.test(t), b: native.checkpointIsIndexLockFailure(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = dotGitName(g); return { a: t.toLowerCase().startsWith('.git'), b: native.checkpointIsDotGit(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = text(g, 12); return { a: t.replace(/[ \t\r\v\f]+$/, ''), b: native.checkpointStripSpace(t) }; })).toBeGreaterThan(0);
    });

    it('판정 하나를 빼거나 넓힌 옛 구현', () => {
      expect(detects((g) => { const c = configCase(g); return { a: legacy.dangerousLocalConfig(c.output.replace(/gpg\./g, 'gpx.'), c.separate), b: native.checkpointDangerousLocalConfig(c.output, c.separate) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const c = configCase(g); return { a: legacy.dangerousLocalConfig(c.output, !c.separate), b: native.checkpointDangerousLocalConfig(c.output, c.separate) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = attributesCase(g); return { a: legacy.infoAttributes(t.replace(/#/g, '')), b: native.checkpointInfoAttributes(t) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const c = stagedCase(g); return { a: legacy.stagedMismatch(c.ls, c.staged, c.subdir, c.expected).slice(1), b: stagedMismatchOf(c.ls, c.staged, c.subdir, c.expected) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const c = porcelainCase(g); return { a: legacy.pendingFiles(c.output, c.subdir).slice(0, -1), b: native.checkpointPendingFiles(c.output, c.subdir).sort() }; })).toBeGreaterThan(0);
      expect(detects((g) => { const c = numstatCase(g); return { a: { insertions: legacy.commitStat(c).insertions + 1, deletions: legacy.commitStat(c).deletions }, b: (([i = 0, d = 0]) => ({ insertions: i, deletions: d }))(native.checkpointCommitStat(c)) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const e = envCase(g); return { a: Object.keys(legacy.gitEnv(e)).filter((key) => !/^GIT_SSL/.test(key)).sort(), b: Object.keys(gitEnvFrom(e)).filter((key) => key in e).sort() }; })).toBeGreaterThan(0);
      expect(detects((g) => { const c = sessionCase(g); return { a: legacy.sessionRecords(c.output, c.ours).map((r) => ({ ...r, ours: true })), b: decodeNative(native.checkpointSessionRecords(c.output, encodeLoneSurrogates(c.ours))) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const c = targetCase(g); return { a: { base: 'x' }, b: decodeNative(native.checkpointPullRequestTarget(c.listed, c.baseRef, c.infoBase)) }; })).toBeGreaterThan(0);
      expect(detects((g) => { const t = credentialText(g); return { a: t.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@'), b: native.checkpointRedactCredentials(t) }; })).toBeGreaterThan(0);
    });
  });
});
