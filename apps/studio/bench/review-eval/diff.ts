/**
 * 평가 세트용 diff 만들기. 파일의 앞뒤 내용(또는 새 파일의 내용)에서 git이 만드는 것과 같은 모양의 통합 diff를 만든다.
 * 줄 번호를 손으로 세지 않으려고 쓴다: 기대 지적의 줄은 결함이 든 줄의 글자(`contains`)로 찾아 이 함수가 만든 새 파일의 줄 번호로 바꾼다.
 */
export interface DiffFile {
  path: string;
  /** 없으면 새 파일 */
  before?: readonly string[];
  after: readonly string[];
}

const CONTEXT = 3;

function fileDiff({ path, before, after }: DiffFile): string {
  const head = [`diff --git a/${path} b/${path}`];
  if (before === undefined) {
    return [...head, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${after.length} @@`, ...after.map((line) => `+${line}`)].join('\n');
  }
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const ctxBefore = Math.min(CONTEXT, prefix);
  const ctxAfter = Math.min(CONTEXT, suffix);
  const start = prefix - ctxBefore;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const lines = [
    ...before.slice(start, prefix).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...before.slice(before.length - suffix, before.length - suffix + ctxAfter).map((line) => ` ${line}`),
  ];
  const oldCount = ctxBefore + removed.length + ctxAfter;
  const newCount = ctxBefore + added.length + ctxAfter;
  return [...head, `--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`, ...lines].join('\n');
}

export function buildDiff(files: readonly DiffFile[]): string {
  return `${files.map(fileDiff).join('\n')}\n`;
}

/** 새 파일의 줄 중 `contains`를 포함한 줄의 번호(1부터). 없거나 둘 이상이면 던진다(기대 지적이 엉뚱한 줄을 가리키지 않게) */
export function lineNumberOf(after: readonly string[], contains: string): number {
  const found = after.flatMap((line, index) => (line.includes(contains) ? [index + 1] : []));
  if (found.length !== 1) throw new Error(`"${contains}"를 포함한 줄이 ${found.length}개입니다(하나여야 합니다)`);
  return found[0]!;
}
