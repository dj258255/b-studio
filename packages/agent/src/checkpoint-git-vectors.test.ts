import { decodeNative, encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { legacy } from './checkpoint-git-legacy';
import { gitEnvFrom, isIndexLockFailure, redactCredentials, stagedMismatchOf } from './checkpoints';

/**
 * 체크포인트의 git 출력 판정 벡터(ADR-191 3s). 기대값은 옮기기 전 TS(`checkpoint-git-legacy.ts`)가 낸 값이다.
 * `CHECKPOINT_GIT_VECTORS_IMPL=legacy`로 돌리면 같은 벡터를 옛 구현에 넣는다: `intended`로 표시한 벡터(의도한 차이)만 실패해야 한다.
 * 경계(상한·하한·±1), 빈 값, 공백 종류와 함께 허용·인식 패턴마다 거의 같은 거부 입력(접두·덧붙임·대소문자·다른 구분자)을 넣었다.
 */

const useLegacy = process.env.CHECKPOINT_GIT_VECTORS_IMPL === 'legacy';

const impl = useLegacy
  ? {
      dangerous: (output: string, separate: boolean) => legacy.dangerousLocalConfig(output, separate),
      attributes: (text: string) => legacy.infoAttributes(text),
      staged: (ls: string, staged: string, subdir: string, expected: ReadonlyMap<string, string>) => legacy.stagedMismatch(ls, staged, subdir, expected),
      pendingFiles: (output: string, subdir: string) => legacy.pendingFiles(output, subdir),
      pendingChanges: (output: string, subdir: string) => legacy.pendingChanges(output, subdir),
      commitStat: (output: string) => legacy.commitStat(output),
      remote: (output: string) => legacy.remoteCommits(output),
      session: (output: string, ours: string) => legacy.sessionRecords(output, ours),
      show: (output: string, ours: string) => legacy.showRecord(output, ours),
      oneLine: legacy.oneLine,
      capText: legacy.capText,
      stripSpace: legacy.stripSpace,
      commitMessage: legacy.commitMessage,
      subcommand: legacy.subcommand,
      redact: legacy.redactCredentials,
      lock: legacy.isIndexLockFailure,
      particle: legacy.withObjectParticle,
      dotGit: legacy.isDotGit,
      sha: legacy.isSha,
      backup: legacy.isBackupId,
      target: (listed: string, baseRef: string, infoBase: string) => legacy.pullRequestTarget(listed, baseRef, infoBase),
      envKeys: (source: Record<string, string>) => Object.keys(legacy.gitEnv(source)).sort(),
    }
  : {
      dangerous: (output: string, separate: boolean) => native.checkpointDangerousLocalConfig(output, separate) ?? undefined,
      attributes: (text: string) => native.checkpointInfoAttributes(text),
      staged: (ls: string, staged: string, subdir: string, expected: ReadonlyMap<string, string>) => stagedMismatchOf(ls, staged, subdir, expected),
      pendingFiles: (output: string, subdir: string) => native.checkpointPendingFiles(output, subdir).sort(),
      pendingChanges: (output: string, subdir: string) =>
        native
          .checkpointPendingChanges(output, subdir)
          .map(([file, change]) => ({ file: file!, change }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      commitStat: (output: string) => {
        const [insertions = 0, deletions = 0] = native.checkpointCommitStat(output);
        return { insertions, deletions };
      },
      remote: (output: string) => native.checkpointRemoteCommits(output).map(([sha = '', shortSha = '', subject = '', author = '']) => ({ sha, shortSha, subject, author })),
      session: (output: string, ours: string) => decodeNative(native.checkpointSessionRecords(output, encodeLoneSurrogates(ours))),
      show: (output: string, ours: string) => decodeNative(native.checkpointShowRecord(output, encodeLoneSurrogates(ours))),
      oneLine: native.checkpointOneLine,
      capText: native.checkpointCapText,
      stripSpace: native.checkpointStripSpace,
      commitMessage: (subject: string, body: string | undefined, trailers: readonly string[]) => native.checkpointCommitMessage(subject, body, [...trailers]),
      subcommand: (args: readonly string[]) => native.checkpointSubcommand([...args]) ?? undefined,
      redact: redactCredentials,
      lock: isIndexLockFailure,
      particle: native.checkpointWithObjectParticle,
      dotGit: native.checkpointIsDotGit,
      sha: native.checkpointIsSha,
      backup: native.checkpointIsBackupId,
      target: (listed: string, baseRef: string, infoBase: string) => decodeNative(native.checkpointPullRequestTarget(listed, baseRef, infoBase)),
      envKeys: (source: Record<string, string>) => Object.keys(gitEnvFrom(source)).filter((key) => key in source).sort(),
    };

interface Vector {
  name: string;
  /** 옛 TS는 다르게 답한다(의도한 차이). 새 구현은 기대값을 낸다 */
  intended: boolean;
  run: () => unknown;
  expected: unknown;
}

const vectors: Vector[] = [];
const add = (name: string, run: () => unknown, expected: unknown, intended = false) => vectors.push({ name, run, expected, intended });

// ── 위험한 로컬 설정 ─────────────────────────────────────────────────────

const cfg = (...entries: Array<[string, string]>) => entries.map(([scope, entry]) => `${scope}\0file:.git/config\0${entry}\0`).join('');
const local = (key: string, value = 'v') => cfg(['local', `${key}\n${value}`]);
const hit = (key: string, scope = '') => [`저장소 설정에 ${key}이(가) 있습니다${scope}`];

const BLOCKED_KEYS = [
  'include.path', 'INCLUDE.PATH', 'includeIf.gitdir:/x.path', 'includeif.onbranch:x.path',
  'url.a.insteadOf', 'URL.A.INSTEADOF', 'url..insteadof', 'url.a.pushInsteadOf', 'url.https://h/.pushinsteadof',
  'credential.helper', 'credential.https://h.username', 'CREDENTIAL.x',
  'core.sshCommand', 'core.gitProxy', 'core.askPass', 'core.worktree', 'CORE.WORKTREE', 'Core.SshCommand',
  'http.extraHeader', 'http.proxy', 'http.sslVerify', 'http.cookieFile', 'http.sslfoo', 'http.https://x/.extraheader', 'http.a.b.proxy', 'http.x.sslCAInfo', 'http.proxyAuthMethod',
  'remote.o.pushurl', 'remote.o.receivepack', 'remote.o.uploadpack', 'remote.o.proxy', 'remote.o.vcs', 'remote.o.proxyx', 'remote.a.b.pushurl', 'remote..vcs',
  'protocol.file.allow', 'protocol.allow', 'filter.lfs.clean', 'filter.x', 'diff.external', 'diff.x.textconv', 'diff.x.command', 'diff.a.b.textconv', 'diff..command',
  'merge.x.driver', 'merge.a.b.driver', 'gpg.program', 'gpg.format', 'GPG.x',
];
for (const key of BLOCKED_KEYS) add(`막는 키 ${key}`, () => impl.dangerous(local(key), false), hit(key));

const PASSING_KEYS = [
  'includes.path', 'include', 'includeifx.path', 'url.insteadof', 'url.a.insteadofx', 'url.a.insteadof.x', 'urlx.a.insteadof', 'xurl.a.insteadof',
  'credentialx.helper', 'credential', 'core.sshcommands', 'core.sshcommand.x', 'core.worktrees', 'xcore.worktree', 'core.worktree\r', 'core.hookspath', 'core.askpass2',
  'http.noproxy', 'httpx.proxy', 'http', 'http.version', 'http.x.version', 'remote.proxy', 'remote.origin.url', 'remote.origin.fetch', 'remote.vcs', 'remoteo.x.proxy',
  'protocols.x', 'protocol', 'filters.x', 'filter', 'diff.external2', 'diff.x.textconvx', 'diff.textconv', 'diff.command', 'diffs.x.command', 'diff.x.commands',
  'merge.driver', 'merge.x.drivers', 'mergex.a.driver', 'gpgx.program', 'gpg', 'user.name', 'user.email', 'branch.main.remote', 'init.defaultbranch', '',
  'commit.gpgsignx', 'xcommit.gpgsign', 'commit.gpgsign.x', 'tag.gpgsignx', 'commit', 'receive.denycurrentbranch',
];
for (const key of PASSING_KEYS) add(`통과하는 키 ${JSON.stringify(key)}`, () => impl.dangerous(local(key), false), []);

// 의도한 차이: 옛 정규식의 `.`은 줄 끝 글자를 맞추지 못해 키 가운데에 그 글자가 있으면 빠져나갔다
for (const key of ['url.a\rb.insteadof', 'url.a\u2028b.pushinsteadof', 'url.\r.insteadof', 'http.a\rb.proxy', 'http.a\u2029b.extraheader', 'remote.o\rrigin.pushurl', 'remote.\u2028.vcs', 'diff.a\rb.textconv', 'diff.a\u2028b.command', 'merge.a\u2029b.driver']) {
  add(`줄 끝 글자가 든 키 ${JSON.stringify(key)}`, () => impl.dangerous(local(key), false), hit(key), true);
}

for (const [value, blocked] of [['true', true], ['', true], ['yes', true], ['on', true], ['1', true], ['false', false], [' FALSE ', false], ['No', false], ['off', false], ['0', false], ['00', true], ['fals', true], ['falsey', true], ['\u00a0false', false], ['\ufefffalse', false], ['x false', true], ['false x', true]] as const) {
  add(`서명 값 ${JSON.stringify(value)}`, () => impl.dangerous(local('commit.gpgsign', value), false), blocked ? hit('commit.gpgsign') : []);
}
add('서명 키가 값 없이 있다', () => impl.dangerous(cfg(['local', 'tag.gpgsign']), false), hit('tag.gpgsign'));
add('worktree 범위 표시', () => impl.dangerous(cfg(['worktree', 'credential.helper\nx']), false), hit('credential.helper', '(config.worktree)'));
add('다른 범위는 보지 않는다', () => impl.dangerous(cfg(['global', 'credential.helper\nx'], ['system', 'include.path\nx'], ['command', 'core.sshcommand\nx'], ['Local', 'include.path\nx'], ['', 'include.path\nx']), false), []);
add('내 폴더 방식은 core.worktree를 뺀다', () => impl.dangerous(cfg(['local', 'core.worktree\n/x'], ['local', 'CORE.Worktree\n/y']), true), []);
add('내 폴더 방식도 다른 키는 막는다', () => impl.dangerous(cfg(['local', 'core.worktree\n/x'], ['local', 'core.sshcommand\nx'], ['local', 'core.worktree.x\n/y']), true), hit('core.sshcommand'));
add('내 폴더 방식이 아니면 core.worktree도 막는다', () => impl.dangerous(cfg(['local', 'core.worktree\n/x']), false), hit('core.worktree'));
add('여러 항목은 순서대로', () => impl.dangerous(cfg(['local', 'user.name\nx'], ['local', 'filter.a.clean\nx'], ['worktree', 'gpg.program\nx']), false), [...hit('filter.a.clean'), ...hit('gpg.program', '(config.worktree)')]);
add('값에 개행이 있어도 키만 본다', () => impl.dangerous(cfg(['local', 'user.name\na\ncredential.helper\nb']), false), []);
add('빈 출력은 빈 목록', () => impl.dangerous('', false), []);
add('끝 NUL이 없어도 읽는다', () => impl.dangerous('local\0file:x\0include.path\nx', false), hit('include.path'));
add('필드가 모자라면 읽지 못한다', () => impl.dangerous('local\0file:x\0', false), undefined);
add('필드가 남으면 읽지 못한다', () => impl.dangerous('a\0b\0c\0d\0', false), undefined);
add('끝 빈 필드는 하나만 뗀다', () => impl.dangerous('a\0b\0c\0\0', false), undefined);

// ── .git/info/attributes ────────────────────────────────────────────────

const attr = (lines: string) => [`.git/info/attributes에 속성이 있습니다: ${lines}`];
for (const [text, expected] of [
  ['', []], ['\n\n', []], ['# 주석', []], ['#', []], ['##x', []], ['  # 들여쓴 주석', []], ['\t# 탭', []], [' \t \n', []], ['#a\r\n#b\r\n', []], ['\r\n\r\n', []],
  ['* filter=x', attr('* filter=x')], ['  * x  ', attr('* x')], ['* x\r\n', attr('* x')], ['x#', attr('x#')], ['a # b', attr('a # b')], ['\\# x', attr('\\# x')],
  ['#c\n* x\n#d\n*.a y', attr('* x / *.a y')], ['a\nb\nc\nd', attr('a / b / c')], ['a\n\nb\n  \nc', attr('a / b / c')], ['*', attr('*')], ['\t*\t', attr('*')],
] as Array<[string, string[]]>) {
  add(`속성 파일 ${JSON.stringify(text)}`, () => impl.attributes(text), expected);
}
// 의도한 차이: git은 ` \t\r\n`만 건너뛴 뒤 '#'을 본다. JS trim이 지우는 글자 뒤의 '#'은 git에서 주석이 아니다
for (const lead of ['\u00a0', '\ufeff', '\v', '\f', '\u3000', '\u2003']) {
  add(`속성 파일: ${JSON.stringify(lead)} 뒤의 #은 주석이 아니다`, () => impl.attributes(`${lead}# * export-ignore`).length, 1, true);
}
add('속성 파일: NBSP만 있는 줄도 센다', () => impl.attributes('\u00a0').length, 1, true);

// ── 스테이지 불일치 ─────────────────────────────────────────────────────

const nul = (...items: string[]) => items.map((item) => `${item}\0`).join('');
const map = (...entries: Array<[string, string]>) => new Map(entries);
const LS = nul('100644 aaa 0\tsrc/a.ts', '120000 bbb 0\tsrc/l', '160000 ccc 0\tsrc/m', '100755 ddd 0\tsrc/x.sh');
const NAMES = nul('src/a.ts', 'src/l', 'src/m', 'src/x.sh', 'other/z');
const FULL = map(['a.ts', 'blob:aaa'], ['l', 'link:'], ['m', 'other'], ['x.sh', 'blob:ddd']);
add('스테이지: 모두 일치', () => impl.staged(LS, NAMES, 'src', FULL), []);
add('스테이지: 지문이 한 글자 다르다', () => impl.staged(LS, NAMES, 'src', map(['a.ts', 'blob:aab'], ['l', 'link:'], ['m', 'other'], ['x.sh', 'blob:ddd'])), ['a.ts']);
add('스테이지: 지문이 접두만 같다', () => impl.staged(LS, NAMES, 'src', map(['a.ts', 'blob:aa'], ['l', 'link:'], ['m', 'other'], ['x.sh', 'blob:ddd'])), ['a.ts']);
add('스테이지: 지문이 덧붙었다', () => impl.staged(LS, NAMES, 'src', map(['a.ts', 'blob:aaaa'], ['l', 'link:'], ['m', 'other'], ['x.sh', 'blob:ddd'])), ['a.ts']);
add('스테이지: 지문 대소문자가 다르다', () => impl.staged(LS, NAMES, 'src', map(['a.ts', 'blob:AAA'], ['l', 'link:'], ['m', 'other'], ['x.sh', 'blob:ddd'])), ['a.ts']);
add('스테이지: 링크 지문에 가리키는 곳이 있으면 다르다', () => impl.staged(LS, NAMES, 'src', map(['a.ts', 'blob:aaa'], ['l', 'link:target'], ['m', 'other'], ['x.sh', 'blob:ddd'])), ['l']);
add('스테이지: 링크로 기대했는데 파일이다', () => impl.staged(LS, NAMES, 'src', map(['a.ts', 'link:'], ['l', 'link:'], ['m', 'other'], ['x.sh', 'blob:ddd'])), ['a.ts']);
add('스테이지: 기대에 없는데 스테이징됨', () => impl.staged(LS, NAMES, 'src', map(['a.ts', 'blob:aaa'], ['l', 'link:'], ['m', 'other'])), ['x.sh']);
add('스테이지: 기대에 있는데 스테이징 안 됨', () => impl.staged(LS, NAMES, 'src', map(...FULL.entries(), ['q', 'missing'])), ['q']);
add('스테이지: 삭제는 missing', () => impl.staged(nul(), nul('gone.ts'), '', map(['gone.ts', 'missing'])), []);
add('스테이지: 삭제인데 파일 지문을 기대', () => impl.staged(nul(), nul('gone.ts'), '', map(['gone.ts', 'blob:1'])), ['gone.ts']);
add('스테이지: 폴더 밖은 보지 않는다', () => impl.staged(nul('100644 a 0\tother/z'), nul('other/z'), 'src', map()), []);
add('스테이지: 폴더 이름이 접두만 같은 경로는 밖이다', () => impl.staged(nul('100644 a 0\tsrcx/z'), nul('srcx/z'), 'src', map()), []);
add('스테이지: 폴더 이름과 같은 파일은 밖이다', () => impl.staged(nul('100644 a 0\tsrc'), nul('src'), 'src', map()), []);
add('스테이지: 폴더 없음(루트)', () => impl.staged(nul('100644 a 0\tx'), nul('x'), '', map(['x', 'blob:a'])), []);
add('스테이지: 결과는 정렬된다', () => impl.staged(nul(), nul('b', 'a', 'c'), '', map()), ['a', 'b', 'c']);
add('스테이지: 같은 경로가 둘 나와도 한 번', () => impl.staged(nul(), nul('a', 'a'), '', map()), ['a']);
add('스테이지: 모드가 없는 항목은 blob:undefined', () => impl.staged(nul('100644\tx'), nul('x'), '', map(['x', 'blob:undefined'])), []);
add('스테이지: 탭이 없는 항목은 읽지 못해 불일치', () => impl.staged(nul('100644 a 0 x'), nul('x'), '', map(['x', 'blob:a'])), ['x']);
add('스테이지: 경로에 탭이 있으면 첫 탭까지가 머리', () => impl.staged(nul('100644 a 0\tx\ty'), nul('x\ty'), '', map(['x\ty', 'blob:a'])), []);
// 짝 없는 서로게이트: 기대 쪽 경로가 U+FFFD가 된 경로와 같다고 읽으면 불일치를 놓친다
add('스테이지: 짝 없는 서로게이트 경로와 U+FFFD 경로는 다르다', () => impl.staged(nul('100644 a 0\ta\ufffd'), nul('a\ufffd'), '', map(['a\ud800', 'blob:a'])), ['a\ud800', 'a\ufffd']);
add('스테이지: 두 짝 없는 서로게이트는 서로 다르다', () => impl.staged(nul('100644 a 0\tx'), nul('x'), '', map(['x', 'blob:a'], ['a\ud800', 'missing'], ['a\udc00', 'missing'])), ['a\ud800', 'a\udc00']);
add('스테이지: 예약 글자가 든 경로는 짝 없는 서로게이트의 인코딩과 다르다', () => impl.staged(nul('100644 a 0\ta\ue010\ue00d\ue008\ue000'), nul('a\ue010\ue00d\ue008\ue000'), '', map(['a\ud800', 'blob:a'])), ['a\ud800', 'a\ue010\ue00d\ue008\ue000']);
add('스테이지: 같은 이름 그대로면 일치', () => impl.staged(nul('100644 a 0\t가\ufffd😀'), nul('가\ufffd😀'), '', map(['가\ufffd😀', 'blob:a'])), []);

// ── status --porcelain -z ───────────────────────────────────────────────

const STATUS_OUT = nul('?? new.ts', ' M mod.ts', 'R  new-name.ts', 'old-name.ts', 'D  gone.ts', 'C  copy.ts', 'src.ts', ' M mod.ts');
add('porcelain 파일: R·C는 원래 경로도, 중복은 한 번, 정렬', () => impl.pendingFiles(STATUS_OUT, ''), ['copy.ts', 'gone.ts', 'mod.ts', 'new-name.ts', 'new.ts', 'old-name.ts', 'src.ts']);
add('porcelain 파일: 폴더 안만', () => impl.pendingFiles(nul('?? p/a', '?? q/b', '?? px/c', '?? p'), 'p'), ['a']);
add('porcelain 파일: 빈 출력', () => impl.pendingFiles('', ''), []);
add('porcelain 파일: 끝 R에 원래 경로가 없다', () => impl.pendingFiles(nul('R  x'), ''), ['x']);
add('porcelain 파일: R로 시작하는 파일 이름은 R 항목이 아니다', () => impl.pendingFiles(nul('?? Rfile', '?? Cfile'), ''), ['Cfile', 'Rfile']);
add('porcelain 파일: 이름이 코드 뒤 한 칸 밖', () => impl.pendingFiles(nul('?? a b'), ''), ['a b']);
add('porcelain 파일: 짧은 항목', () => impl.pendingFiles(nul('??', 'A '), ''), ['']);
const kinds = (output: string, subdir = '') => impl.pendingChanges(output, subdir);
add('porcelain 종류: 추가·수정·삭제', () => kinds(nul('?? n.ts', ' M m.ts', 'A  a.ts', ' D d.ts', 'AD ad.ts', 'MM mm.ts', 'UU u.ts', ' T t.ts', 'DD dd.ts')), [
  { file: 'a.ts', change: 'added' },
  { file: 'ad.ts', change: 'added' },
  { file: 'd.ts', change: 'deleted' },
  { file: 'dd.ts', change: 'deleted' },
  { file: 'm.ts', change: 'modified' },
  { file: 'mm.ts', change: 'modified' },
  { file: 'n.ts', change: 'added' },
  { file: 't.ts', change: 'modified' },
  { file: 'u.ts', change: 'modified' },
]);
add('porcelain 종류: 이름 변경은 새 경로 추가, 옛 경로 삭제', () => kinds(nul('R  to.ts', 'from.ts', 'C  c.ts', 'o.ts')), [
  { file: 'c.ts', change: 'added' },
  { file: 'from.ts', change: 'deleted' },
  { file: 'o.ts', change: 'deleted' },
  { file: 'to.ts', change: 'added' },
]);
add('porcelain 종류: 같은 경로가 다시 나오면 마지막 값', () => kinds(nul('R  a', 'b', ' D b')), [
  { file: 'a', change: 'added' },
  { file: 'b', change: 'deleted' },
]);
add('porcelain 종류: 폴더 안만 프로젝트 기준으로', () => kinds(nul('?? s/x', '?? t/y', '?? sx/z'), 's'), [{ file: 'x', change: 'added' }]);
add('porcelain 종류: 코드 칸의 A·D는 어느 자리든', () => kinds(nul(' A a', 'A  b', ' D c', 'AD d')), [
  { file: 'a', change: 'added' },
  { file: 'b', change: 'added' },
  { file: 'c', change: 'deleted' },
  { file: 'd', change: 'added' },
]);

// ── numstat ─────────────────────────────────────────────────────────────

for (const [out, expected] of [
  ['1\t2\ta\n3\t4\tb\n', [4, 6]], ['-\t-\tbin\n1\t1\tx', [1, 1]], ['', [0, 0]], ['\n\n', [0, 0]], ['1\t\tp', [0, 0]], ['\t2\tp', [0, 0]], ['-\t3\tp', [0, 0]], ['3\t-\tp', [0, 0]],
  [' 5 \t0x10\tq', [5, 16]], ['1e3\t1\tp', [1000, 1]], ['abc\t1\tp', [0, 1]], ['1\tabc\tp', [1, 0]], ['-5\t5\tp', [-5, 5]], ['0b11\t0o7\tp', [3, 7]], ['1.5\t.5\tp', [1.5, 0.5]],
  ['1\t2', [1, 2]], ['1', [0, 0]], ['00\t01\tp', [0, 1]], ['+3\t-0\tp', [3, 0]],
] as Array<[string, number[]]>) {
  add(`numstat ${JSON.stringify(out)}`, () => impl.commitStat(out), { insertions: expected[0], deletions: expected[1] });
}
add('numstat: Infinity는 그대로 더한다', () => impl.commitStat('Infinity\t1\tp').insertions, Infinity);

// ── 레코드 ──────────────────────────────────────────────────────────────

const OURS = 'checkpoints@b-studio.local';
const rec = (...fields: string[]) => fields.join('\0');
add('원격 커밋 레코드', () => impl.remote(`${rec('a', 'b', 'c', 'd')}\x1e\n${rec('e', 'f', 'g', 'h')}\x1e\n`), [
  { sha: 'a', shortSha: 'b', subject: 'c', author: 'd' },
  { sha: 'e', shortSha: 'f', subject: 'g', author: 'h' },
]);
add('원격 커밋: 필드가 모자라면 빈 글자', () => impl.remote('x\x1e'), [{ sha: 'x', shortSha: '', subject: '', author: '' }]);
add('원격 커밋: 빈 레코드는 버린다', () => impl.remote('\n\x1e\x1e\n'), []);
add('원격 커밋: 줄바꿈은 하나만 뗀다', () => impl.remote('\n\na\x1e'), [{ sha: '\na', shortSha: '', subject: '', author: '' }]);
add('원격 커밋: 필드가 넘치면 버린다', () => impl.remote(`${rec('a', 'b', 'c', 'd', 'e')}\x1e`), [{ sha: 'a', shortSha: 'b', subject: 'c', author: 'd' }]);
interface SessionRecord {
  ours: boolean;
  body: string;
  trailers: string[];
  verifyTrailers: string[];
  incompleteTrailers: string[];
}
const sess = (email: string, ours = OURS) => impl.session(`${rec('s1', 'h1', '제목', ' 본문\n둘째 ', email, 'a\x1fb', 'docs', '')}\x1e\n`, ours) as SessionRecord[];
add('세션 커밋: 본문은 다듬고 트레일러는 \\x1f로 나눈다', () => {
  const [r] = sess(OURS);
  return [r!.body, r!.trailers, r!.verifyTrailers, r!.incompleteTrailers];
}, ['본문\n둘째', ['a', 'b'], ['docs'], ['']]);
for (const [email, ours] of [
  [OURS, true], [` ${OURS} `, true], [OURS.toUpperCase(), true], ['Checkpoints@B-Studio.Local', true], ['chec\u212apoints@b-studio.local', true],
  [`x${OURS}`, false], [`${OURS}x`, false], ['checkpoints@b-studio.loca1', false], ['', false], ['a@b.c', false], [`${OURS}\n`, true], [`\u00a0${OURS}`, true], [`${OURS}.`, false], [`${OURS}\u200b`, false], ['checkpoints@b-studio.\u0130ocal', false],
] as Array<[string, boolean]>) {
  add(`작성자 비교 ${JSON.stringify(email)}`, () => sess(email)[0]!.ours, ours);
}
add('작성자 비교: 기준 쪽 공백·대소문자도 무시', () => sess(OURS, ` ${OURS.toUpperCase()} `)[0]!.ours, true);
add('작성자 비교: 기준이 비면 빈 이메일만', () => [sess('', '')[0]!.ours, sess(OURS, '')[0]!.ours], [true, false]);
add('작성자 비교: 짝 없는 서로게이트 이메일은 U+FFFD와 같지 않다', () => sess('a\ufffd@x', 'a\ud800@x')[0]!.ours, false);
add('작성자 비교: 예약 글자 이메일은 짝 없는 서로게이트의 인코딩과 같지 않다', () => sess('a\ue010\ue00d\ue008\ue000@x', 'a\ud800@x')[0]!.ours, false);
const shown = (text: string, ours = OURS) => impl.show(text, ours) as { sha: string; createdAt: string; ours: boolean; trailers: string[] };
add('show 레코드', () => {
  const r = shown(`\n ${rec('s', 'h', '제목', '2026-11-10T00:00:00+09:00', OURS, 'a', '', '')}\n`);
  return [r.sha, r.createdAt, r.ours, r.trailers];
}, ['s', '2026-11-10T00:00:00+09:00', true, ['a']]);
add('show 레코드: 필드가 모자라면 빈 글자·남의 것', () => {
  const r = shown('s\0h');
  return [r.sha, r.createdAt, r.ours];
}, ['s', '', false]);
add('show 레코드: 빈 출력', () => {
  const r = shown('');
  return [r.sha, r.ours, r.trailers];
}, ['', false, ['']]);

// ── 글자 다듬기 ─────────────────────────────────────────────────────────

for (const [input, expected] of [
  ['', '체크포인트'], ['   ', '체크포인트'], ['\n\t ', '체크포인트'], ['\u00a0\ufeff', '체크포인트'], ['a', 'a'], ['  a   b\n\nc  ', 'a b c'], ['a\u00a0\u3000b', 'a b'],
  ['가'.repeat(119), '가'.repeat(119)], ['가'.repeat(120), '가'.repeat(120)], ['가'.repeat(121), '가'.repeat(120)], ['a '.repeat(80), 'a '.repeat(60)],
  ['😀'.repeat(60), '😀'.repeat(60)], ['\u0085x', '\u0085x'],
] as Array<[string, string]>) {
  add(`한 줄 ${JSON.stringify(input.slice(0, 20))}(${input.length})`, () => impl.oneLine(input), expected);
}
add('한 줄: 120 경계에서 쌍을 가르면 U+FFFD', () => impl.oneLine(`${'a'.repeat(119)}😀`), `${'a'.repeat(119)}\ufffd`, true);
for (const [text, max, expected, intended] of [
  ['abc', 3, 'abc', false], ['abcd', 3, 'abc\n[... 길어서 1자를 생략했습니다 ...]\n', false], ['', 0, '', false], ['a', 0, '\n[... 길어서 1자를 생략했습니다 ...]\n', false], ['가'.repeat(8000), 8000, '가'.repeat(8000), false],
  ['가'.repeat(8001), 8000, `${'가'.repeat(8000)}\n[... 길어서 1자를 생략했습니다 ...]\n`, false], ['😀😀', 4, '😀😀', false], ['😀😀', 3, '😀\ufffd\n[... 길어서 1자를 생략했습니다 ...]\n', true],
] as Array<[string, number, string, boolean]>) {
  add(`길이 자르기 ${JSON.stringify(text.slice(0, 6))}/${max}`, () => impl.capText(text, max), expected, intended);
}
for (const [input, expected] of [
  ['', ''], ['\n\n\n', ''], ['a  \n\n\n\nb\t\n\n', 'a\n\nb'], ['a\r\nb', 'a\nb'], [' a', ' a'], ['a \v\f\r', 'a'], ['a\u00a0\nb', 'a\u00a0\nb'], ['\n\na\n', 'a'], ['a\n \nb', 'a\n\nb'],
] as Array<[string, string]>) {
  add(`stripspace ${JSON.stringify(input)}`, () => impl.stripSpace(input), expected);
}
add('커밋 메시지: 제목·본문·트레일러', () => impl.commitMessage('  제목  \n둘째 ', '본문\n\n\n  끝  ', ['Workflow-Passed: a, b', 'X: y']), '제목 둘째\n\n본문\n\n  끝\n\nWorkflow-Passed: a, b\nX: y');
add('커밋 메시지: 본문 없음', () => impl.commitMessage('x', undefined, ['T: 1']), 'x\n\nT: 1');
add('커밋 메시지: 빈 본문은 없는 것', () => impl.commitMessage('x', '', []), 'x');
add('커밋 메시지: 공백 본문은 있는 것', () => impl.commitMessage('x', '   ', []), 'x');
add('커밋 메시지: 제목이 비면 기본 제목', () => impl.commitMessage('', undefined, []), '체크포인트');
add('커밋 메시지: 트레일러 줄은 한 줄로', () => impl.commitMessage('x', undefined, ['A:  b\n c', '']), 'x\n\nA: b c\n체크포인트');
add('커밋 메시지: 본문 8000자 경계', () => impl.commitMessage('x', 'b'.repeat(8000), []), `x\n\n${'b'.repeat(8000)}`);
add('커밋 메시지: 본문 8001자는 자른다', () => impl.commitMessage('x', 'b'.repeat(8001), []), `x\n\n${'b'.repeat(8000)}\n[... 길어서 1자를 생략했습니다 ...]`);

// ── 하위 명령 · 자격 증명 · 잠금 · 조사 ─────────────────────────────────

for (const [args, expected] of [
  [['status'], 'status'], [['-C', 'x', 'status'], 'status'], [['-c', 'a=b', '-C', 'x', 'log'], 'log'], [['--git-dir', 'g', '--work-tree', 'w', 'diff'], 'diff'], [[], undefined], [['-C'], undefined], [['-C', 'x'], undefined],
  [['--no-pager', 'log'], '--no-pager'], [['-c=a', 'x'], '-c=a'], [['-C ', 'x'], '-C '], [['', 'x'], ''], [['--git-dir=x', 'log'], '--git-dir=x'],
] as Array<[string[], string | undefined]>) {
  add(`하위 명령 ${JSON.stringify(args)}`, () => impl.subcommand(args), expected);
}
for (const [input, expected] of [
  ['fatal: https://tok@github.com/x 실패', 'fatal: https://***@github.com/x 실패'], ["'ssh://u:p@h/r' 와 git+ssh://a@b", "'ssh://***@h/r' 와 git+ssh://***@b"], ['HTTP://T@H', 'HTTP://***@H'],
  ['https://github.com/x@y', 'https://github.com/x@y'], ['https://@h', 'https://@h'], ['https://a b@c', 'https://a b@c'], ['https://a\u00a0b@c', 'https://a\u00a0b@c'], ['https://a\u0085b@c', 'https://***@c'],
  ['9https://tok@h', '9https://tok@h'], ['_https://tok@h', '_https://tok@h'], ['x.https://t@h', 'x.https://***@h'], ['-https://t@h', '-https://***@h'], ['é https://t@h', 'é https://***@h'], ['éhttps://t@h', 'éhttps://***@h'],
  ['a://b@c://d@e', 'a://***@c://***@e'], ['://t@h', '://t@h'], ['https:/t@h', 'https:/t@h'], ['https//t@h', 'https//t@h'], ['1://t@h', '1://t@h'], ['a+b-c.d://t@h', 'a+b-c.d://***@h'], ['ſ://t@h', 'ſ://t@h'], ['k\u212a://t@h', 'k\u212a://t@h'],
  ['https://t@', 'https://***@'], ['https://t:p@h@i', 'https://***@h@i'], ['https://t/x@h', 'https://t/x@h'],
] as Array<[string, string]>) {
  add(`자격 증명 가림 ${JSON.stringify(input)}`, () => impl.redact(input), expected);
}
for (const [input, expected] of [
  ["fatal: Unable to create '/x/.git/index.lock': File exists.", true], ['index.lock another git process', true], ['index.lock ANOTHER GIT PROCESS', true], ['index.lock file EXISTS', true], ['index.lock unable TO create', true],
  ['Unable to create', false], ['INDEX.LOCK file exists', false], ['index.lock', false], ['index_lock file exists', false], ['index.lock file  exists', false], ['index.lock Another git proces', false], ['indexxlock file exists', false], ['', false],
] as Array<[string, boolean]>) {
  add(`잠금 실패 ${JSON.stringify(input)}`, () => impl.lock(input), expected);
}
for (const [input, expected] of [
  ['main', 'main을'], ['may', 'may을'], ['Y', 'Y을'], ['release', 'release를'], [' dev ', ' dev 을'], ['RELEASE', 'RELEASE를'], ['a', 'a를'], ['b', 'b을'], ['', '을'], ['가', '가을'], ['Ä', 'Ä을'], ['İ', 'İ를'], ['é', 'é을'], ['\u212a', '\u212a을'], ['ab\n', 'ab\n을'],
] as Array<[string, string]>) {
  add(`조사 ${JSON.stringify(input)}`, () => impl.particle(input), expected);
}
// 의도한 차이: 짝 없는 서로게이트는 경계에서 U+FFFD가 된다(조사 선택에는 영향이 없다)
add('조사: 짝 없는 서로게이트는 U+FFFD', () => impl.particle('x\ud83d'), 'x\ufffd을', true);

// ── .git 이름 · ID ──────────────────────────────────────────────────────

for (const [name, expected] of [
  ['.git', true], ['.GIT', true], ['.Git', true], ['.gIt', true], ['.git ', false], [' .git', false], ['git', false], ['.gıt', false], ['.gİt', false], ['.\u212ait', false], ['.gi', false], ['.gitt', false], ['..git', false], ['.git.', false], ['.git\0', false], ['', false],
] as Array<[string, boolean]>) {
  add(`.git 이름 ${JSON.stringify(name)}`, () => impl.dotGit(name), expected);
}
for (const [id, expected] of [
  ['abcdef0', true], ['abcdef', false], ['a'.repeat(40), true], ['a'.repeat(41), false], ['a'.repeat(7), true], ['a'.repeat(6), false], ['ABCDEF0', false], ['abcdef0\n', false], ['abcdeg0', false], ['abcdef0 ', false], [' abcdef0', false], ['0123456789abcdef', true], ['', false],
] as Array<[string, boolean]>) {
  add(`체크포인트 ID ${JSON.stringify(id.slice(0, 12))}(${id.length})`, () => impl.sha(id), expected);
}
for (const [id, expected] of [
  ['a'.repeat(10), true], ['a'.repeat(9), false], ['a'.repeat(64), true], ['a'.repeat(65), false], ['A-z9'.repeat(4), true], ['aaaaaaaaa_', false], ['aaaaaaaaa.', false], ['aaaaaaaaa/', false], ['aaaaaaaaa\n', false], ['aaaaaaaaa ', false], ['aaaaaaaaa..', false], ['../aaaaaaaa', false], ['aaaaaaaaaé', false], ['', false],
] as Array<[string, boolean]>) {
  add(`백업 ID ${JSON.stringify(id.slice(0, 12))}(${id.length})`, () => impl.backup(id), expected);
}

// ── 풀 요청 대상 ────────────────────────────────────────────────────────

const target = (listed: string, baseRef = 'refs/heads/main', infoBase = 'main') => impl.target(listed, baseRef, infoBase);
for (const [listed, expected] of [
  ['sha\trefs/heads/main\n', { base: 'main' }], ['ref: refs/heads/trunk\tHEAD\nsha\tHEAD\n', { base: 'trunk', missingBase: 'main' }], ['sha\tHEAD\n', { base: 'main', missingBase: 'main' }],
  ['ref: refs/heads/a b\tHEAD', { base: 'main', missingBase: 'main' }], ['ref: refs/heads/\tHEAD', { base: 'main', missingBase: 'main' }], ['s\trefs/heads/main2', { base: 'main', missingBase: 'main' }], ['s\txrefs/heads/main', { base: 'main', missingBase: 'main' }],
  ['s refs/heads/main', { base: 'main', missingBase: 'main' }], ['s\trefs/heads/main\r\n', { base: 'main' }], ['ref: refs/heads/dev\tHEAD\r\n', { base: 'dev', missingBase: 'main' }], ['ref: refs/heads/a/b\tHEAD', { base: 'a/b', missingBase: 'main' }],
  ['ref: refs/heads/dev\tHEADx', { base: 'main', missingBase: 'main' }], ['ref: refs/heads/dev\tHEAD\textra', { base: 'main', missingBase: 'main' }], ['ref: refs/tags/dev\tHEAD', { base: 'main', missingBase: 'main' }], ['ref:refs/heads/dev\tHEAD', { base: 'main', missingBase: 'main' }],
  ['x\nref: refs/heads/dev\tHEAD\nref: refs/heads/other\tHEAD', { base: 'dev', missingBase: 'main' }], ['ref: junk\nref: refs/heads/dev\tHEAD', { base: 'main', missingBase: 'main' }], ['', { base: 'main', missingBase: 'main' }],
] as Array<[string, object]>) {
  add(`풀 요청 대상 ${JSON.stringify(listed)}`, () => target(listed), expected);
}

// ── git 환경 ────────────────────────────────────────────────────────────

const envOf = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, 'x']));
add('git 환경: GIT_*는 허용 목록만 남긴다', () => impl.envKeys(envOf('PATH', 'HOME', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_WORK_TREE', 'GIT_AUTHOR_NAME', 'GIT_SSH_COMMAND', 'GIT_SSL_CAINFO', 'GIT_CONFIG_GLOBAL', 'GIT_ASKPASS', 'HTTPS_PROXY')), [
  'GIT_ASKPASS', 'GIT_AUTHOR_NAME', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'GIT_SSL_CAINFO', 'HOME', 'HTTPS_PROXY', 'PATH',
]);
add('git 환경: 소문자·섞인 대소문자 GIT_*도 막는다', () => impl.envKeys(envOf('git_dir', 'Git_Index_File', 'gIt_WoRk_TrEe', 'git_author_name')), []);
add('git 환경: 허용 이름은 대소문자를 구분한다', () => impl.envKeys(envOf('git_ssh_command', 'GIT_ssh_command', 'GIT_SSH_COMMAND')), ['GIT_SSH_COMMAND']);
add('git 환경: 접두·덧붙임은 허용 이름이 아니다', () => impl.envKeys(envOf('GIT_SSH_COMMAND2', 'XGIT_SSH_COMMAND', 'GIT_SSH_COMMAND_', 'GIT_SSH_COMMAND_X')), ['XGIT_SSH_COMMAND']);
add('git 환경: GIT_로 시작하지 않으면 남긴다', () => impl.envKeys(envOf('GITX', 'GIT', 'GIT_', 'XGIT_DIR', 'GİT_DIR', 'ſGIT_DIR')), ['GITX', 'GIT', 'XGIT_DIR', 'GİT_DIR', 'ſGIT_DIR'].sort());
add('git 환경: 짝 없는 서로게이트가 든 이름도 지운다', () => impl.envKeys(envOf('GIT_X\ud800', 'GIT_SSH_COMMAND\udc00', 'GIT_AUTHOR_NAME\ud83d', 'GIT_AUTHOR_NAME')), ['GIT_AUTHOR_NAME']);

// ── 시험 ─────────────────────────────────────────────────────────────────

describe(`체크포인트 git 판정 벡터(${useLegacy ? '옛 TS' : 'Rust 껍데기'})`, () => {
  it('벡터 수', () => {
    expect(vectors.length).toBeGreaterThan(400);
  });
  it('의도한 차이 벡터 수', () => {
    expect(vectors.filter((vector) => vector.intended)).toHaveLength(20);
  });
  for (const vector of vectors) {
    if (useLegacy && vector.intended) {
      it(`${vector.name} (의도한 차이: 옛 TS는 다르게 답한다)`, () => {
        expect(vector.run()).not.toEqual(vector.expected);
      });
    } else {
      it(vector.name, () => {
        expect(vector.run()).toEqual(vector.expected);
      });
    }
  }
});
