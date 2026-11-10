/**
 * 체크포인트의 git 출력 판정을 Rust로 옮기기 전(ADR-191 3s) `checkpoints.ts`에 있던 구현을 그대로 둔 것이다(메서드 안의 인라인 논리는 입력을 인자로 받게 뺐다).
 * 차등 시험(`checkpoint-git-differential.test.ts`)과 벡터 시험(`checkpoint-git-vectors.test.ts`)이 기준으로 삼는다. 제품 코드는 이 파일을 쓰지 않는다. 지우지 않는다.
 */

export const legacy = (() => {
  const DANGEROUS_LOCAL_CONFIG = [
    /^include\./i,
    /^includeif\./i,
    /^url\..*\.insteadof$/i,
    /^url\..*\.pushinsteadof$/i,
    /^credential\./i,
    /^core\.(sshcommand|gitproxy|askpass|worktree)$/i,
    /^http\.(.*\.)?(extraheader|proxy|ssl|cookiefile)/i,
    /^remote\..*\.(pushurl|receivepack|uploadpack|proxy|vcs)/i,
    /^protocol\./i,
    /^filter\./i,
    /^diff\.external$/i,
    /^diff\..*\.(textconv|command)$/i,
    /^merge\..*\.driver$/i,
    /^gpg\./i,
  ];
  const DANGEROUS_WHEN_ENABLED = [/^commit\.gpgsign$/i, /^tag\.gpgsign$/i];
  const PASSED_GIT_ENV = new Set([
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ASKPASS',
    'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  ]);
  const SHA = /^[0-9a-f]{7,40}$/;
  const BACKUP_ID = /^[0-9A-Za-z-]{10,64}$/;
  const MAX_BODY_CHARS = 8_000;

  function dangerousLocalConfig(output: string, separateGitDir: boolean): string[] | undefined {
    const fields = output.split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 3 !== 0) return undefined;
    const found: string[] = [];
    for (let index = 0; index < fields.length; index += 3) {
      const scope = fields[index]!;
      if (scope !== 'local' && scope !== 'worktree') continue;
      const entry = fields[index + 2]!;
      const newline = entry.indexOf('\n');
      const key = newline < 0 ? entry : entry.slice(0, newline);
      const value = newline < 0 ? 'true' : entry.slice(newline + 1);
      const enabled = !/^(false|no|off|0)$/i.test(value.trim());
      if (/^core\.worktree$/i.test(key) && separateGitDir) continue;
      if (DANGEROUS_LOCAL_CONFIG.some((pattern) => pattern.test(key)) || (enabled && DANGEROUS_WHEN_ENABLED.some((pattern) => pattern.test(key)))) {
        found.push(`저장소 설정에 ${key}이(가) 있습니다${scope === 'worktree' ? '(config.worktree)' : ''}`);
      }
    }
    return found;
  }

  function infoAttributes(text: string): string[] {
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    return lines.length > 0 ? [`.git/info/attributes에 속성이 있습니다: ${lines.slice(0, 3).join(' / ')}`] : [];
  }

  function fromRoot(files: string[], subdir: string): string[] {
    if (!subdir) return files;
    return files.filter((file) => file.startsWith(`${subdir}/`)).map((file) => file.slice(subdir.length + 1));
  }

  function stagedMismatch(lsFiles: string, stagedNames: string, subdir: string, expected: ReadonlyMap<string, string>): string[] {
    const staged = fromRoot(stagedNames.split('\0').filter(Boolean), subdir);
    const index = new Map<string, string>();
    for (const entry of lsFiles.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, id] = entry.slice(0, tab).split(' ');
      const [file] = fromRoot([entry.slice(tab + 1)], subdir);
      if (file === undefined) continue;
      index.set(file, mode === '120000' ? 'link:' : mode === '160000' ? 'other' : `blob:${id}`);
    }
    const mismatched = new Set<string>();
    for (const file of staged) {
      const actual = index.get(file) ?? 'missing';
      if (expected.get(file) !== actual) mismatched.add(file);
    }
    for (const file of expected.keys()) {
      if (!staged.includes(file)) mismatched.add(file);
    }
    return [...mismatched].sort();
  }

  function pendingFiles(output: string, subdir: string): string[] {
    const entries = output.split('\0').filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      files.push(entry.slice(3));
      if (entry[0] === 'R' || entry[0] === 'C') {
        const original = entries[++i];
        if (original) files.push(original);
      }
    }
    return fromRoot([...new Set(files)], subdir).sort();
  }

  function pendingChanges(output: string, subdir: string): Array<{ file: string; change: string }> {
    const entries = output.split('\0').filter(Boolean);
    const changes = new Map<string, string>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C') {
        const original = entries[++i];
        if (original) changes.set(original, 'deleted');
        changes.set(file, 'added');
        continue;
      }
      changes.set(file, code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified');
    }
    return [...changes.entries()]
      .filter(([file]) => !subdir || file.startsWith(`${subdir}/`))
      .map(([file, change]) => ({ file: subdir ? file.slice(subdir.length + 1) : file, change }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  function commitStat(output: string): { insertions: number; deletions: number } {
    let insertions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
      const [added, removed] = line.split('\t');
      if (added && removed && added !== '-' && removed !== '-') {
        insertions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
    }
    return { insertions, deletions };
  }

  function remoteCommits(output: string) {
    return output
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter(Boolean)
      .map((record) => {
        const [sha = '', shortSha = '', subject = '', author = ''] = record.split('\0');
        return { sha, shortSha, subject, author };
      });
  }

  function sessionRecords(output: string, ourEmail: string) {
    return output
      .split('\x1e')
      .map((record) => record.replace(/^\n/, ''))
      .filter(Boolean)
      .map((record) => {
        const [sha = '', shortSha = '', subject = '', body = '', authorEmail = '', trailers = '', verifyTrailers = '', incompleteTrailers = ''] = record.split('\0');
        const ours = authorEmail.trim().toLowerCase() === ourEmail.trim().toLowerCase();
        return { sha, shortSha, subject, body: body.trim(), ours, trailers: trailers.split('\x1f'), verifyTrailers: verifyTrailers.split('\x1f'), incompleteTrailers: incompleteTrailers.split('\x1f') };
      });
  }

  function showRecord(output: string, ourEmail: string) {
    const [sha = '', shortSha = '', subject = '', createdAt = '', authorEmail = '', trailers = '', verifyTrailers = '', incompleteTrailers = ''] = output.trim().split('\0');
    const ours = authorEmail.trim().toLowerCase() === ourEmail.trim().toLowerCase();
    return { sha, shortSha, subject, createdAt, ours, trailers: trailers.split('\x1f'), verifyTrailers: verifyTrailers.split('\x1f'), incompleteTrailers: incompleteTrailers.split('\x1f') };
  }

  function oneLine(message: string): string {
    return message.replace(/\s+/g, ' ').trim().slice(0, 120) || '체크포인트';
  }

  function capText(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[... 길어서 ${text.length - max}자를 생략했습니다 ...]\n`;
  }

  function stripSpace(text: string): string {
    const lines: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.replace(/[ \t\r\v\f]+$/, '');
      if (line === '' && (lines.length === 0 || lines.at(-1) === '')) continue;
      lines.push(line);
    }
    while (lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }

  function commitMessage(subject: string, body: string | undefined, trailers: readonly string[]): string {
    const paragraphs = [oneLine(subject), ...(body ? [capText(body, MAX_BODY_CHARS)] : []), ...(trailers.length > 0 ? [trailers.map(oneLine).join('\n')] : [])];
    return stripSpace(paragraphs.join('\n\n'));
  }

  function subcommand(args: readonly string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-C' || args[i] === '--git-dir' || args[i] === '--work-tree' || args[i] === '-c') i++;
      else return args[i];
    }
    return undefined;
  }

  function redactCredentials(text: string): string {
    return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
  }

  function isIndexLockFailure(stderr: string): boolean {
    return /index\.lock/.test(stderr) && /File exists|Unable to create|Another git process/i.test(stderr);
  }

  function withObjectParticle(word: string): string {
    const last = word.trim().slice(-1).toLowerCase();
    return /[aeiou]/.test(last) ? `${word}를` : `${word}을`;
  }

  function isDotGit(name: string): boolean {
    return name.toLowerCase() === '.git';
  }

  function pullRequestTarget(listed: string, baseRef: string, infoBase: string): { base: string; missingBase?: string } {
    const lines = listed.split('\n').map((line) => line.trim());
    return lines.some((line) => line.endsWith(`\t${baseRef}`))
      ? { base: infoBase }
      : { base: /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(lines.find((line) => line.startsWith('ref: ')) ?? '')?.[1] ?? infoBase, missingBase: infoBase };
  }

  function gitEnv(source: Record<string, string>): Record<string, string> {
    const env = { ...source };
    for (const key of Object.keys(env)) {
      if (/^GIT_/i.test(key) && !PASSED_GIT_ENV.has(key)) delete env[key];
    }
    return env;
  }

  return {
    dangerousLocalConfig,
    infoAttributes,
    stagedMismatch,
    pendingFiles,
    pendingChanges,
    commitStat,
    remoteCommits,
    sessionRecords,
    showRecord,
    oneLine,
    capText,
    stripSpace,
    commitMessage,
    subcommand,
    redactCredentials,
    isIndexLockFailure,
    withObjectParticle,
    isDotGit,
    isSha: (text: string) => SHA.test(text),
    isBackupId: (text: string) => BACKUP_ID.test(text),
    pullRequestTarget,
    gitEnv,
  };
})();
