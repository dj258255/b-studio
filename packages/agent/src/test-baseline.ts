import type { Sandbox } from '@b-studio/sandbox';
import type { CheckpointStore } from './checkpoints';

/**
 * 선언한 시험이 실패했을 때, 그 실패가 변경 전부터 있던 것인지 가르는 기준(이슈 #1435).
 *
 * **이 파일의 결과는 피드백 글에만 쓴다.** 통과·실패 판정, 재시도 횟수, 게이트 결과는 이 값을 읽지 않는다(판정은 Rust `gate_declared.rs`가 시험 종료 코드로 정한다).
 * 라벨은 셋이다: `before`(변경 전에도 실패), `now`(변경 전에는 통과했다 = 이번 변경으로 실패), `unknown`(모름).
 * 변경 전 나무를 만들지 못했거나, 시험이 실제로 돌았다는 표시를 받지 못했거나, 시간이 넘었으면 **언제나 `unknown`** 이다. `before`로 추정하는 길은 없다.
 *
 * 기준: 마지막 체크포인트. 작업 복사본은 그 체크포인트에 이번 실행의 변경(`pendingChanges`)이 얹힌 것이라, 변경 전 나무는 같은 서비스 컨테이너 **안**에서
 * 작업 폴더를 임시 폴더로 복사한 뒤 바뀐 파일만 체크포인트의 내용으로 되돌려 만든다. 호스트의 작업 복사본은 읽기만 하고(복사는 컨테이너 안에서 한다) 쓰지 않는다 —
 * 사용자의 변경을 되돌리거나 덮어쓸 길이 없다. 같은 컨테이너에서 도니 의존성·도구 체인이 그대로고 서비스를 다시 띄울 필요가 없다.
 */

export type BaselineReason = 'no-baseline' | 'timeout' | 'too-large' | 'untracked-changes' | 'unsupported-file' | 'setup-failed' | 'platform' | 'aborted';

export type BaselineLabel = { label: 'before' } | { label: 'now' } | { label: 'unknown'; reason: BaselineReason };

/** 기준 체크포인트와 작업 복사본이 다른 파일 하나. `content`가 null이면 기준에는 없던 파일(이번에 새로 만든 것)이다 */
export interface BaselineFile {
  /** 프로젝트 폴더 기준 경로 */
  path: string;
  content: Buffer | null;
  executable: boolean;
}

export type BaselineSnapshot = { kind: 'ok'; files: readonly BaselineFile[] } | { kind: 'unknown'; reason: BaselineReason };

/** 변경 전 나무를 만드는 데 필요한 것을 모은다. 못 모으면 이유를 담아 `unknown`으로 돌려준다(던지지 않는다) */
export interface BaselineSource {
  load(): Promise<BaselineSnapshot>;
}

/** 컨테이너의 표준 입력으로 보내는 크기 상한(원본 바이트). 넘으면 변경 전 나무를 만들지 않는다 */
export const MAX_BASELINE_BYTES = 256 * 1024;
export const MAX_BASELINE_FILES = 200;

/** 스크립트가 변경 전 나무를 다 만들고 시험을 시작하기 직전에 찍는 표시. 이 표시가 없으면 시험이 돈 것이 아니다 */
export const BASELINE_READY_MARK = '__B_STUDIO_BASELINE_READY__';

/** 이 종료 코드는 셸이 명령을 찾지 못했거나 실행하지 못한 것이다. 변경 전에 그 명령(시험 파일)이 없었을 수 있어 "변경 전에도 실패"로 읽지 않는다 */
const NOT_RUNNABLE_CODES = new Set([126, 127]);

/**
 * 컨테이너 안에서 도는 셸 스크립트(`sh -c`의 인자, 시험 명령은 그 뒤 인자 배열로 넘기고 셸 문자열에 잇지 않는다). 표준 입력은 줄마다 `W|D <x|-> <경로 base64> <내용 base64>`다.
 * 작업 폴더(`pwd`)를 `mktemp -d` 폴더로 복사하고(`cp -a`: 링크는 링크 그대로 복사본 안에 둔다), 바뀐 파일만 복사본에서 기준의 내용으로 되돌린 뒤 거기서 시험 명령을 돈다.
 * 복사본 밖을 쓰지 못하게 닫는 자리: 경로가 절대 경로·`..`·빈 값이면 중단, 경로의 상위 폴더 중 링크가 있으면 중단(링크를 따라 원본을 쓰지 않는다),
 * 쓰기 전에 그 이름을 먼저 지워(`rm -f`) 파일 자체가 링크여도 링크 너머를 쓰지 않는다. 정리는 `mktemp`가 만든 폴더 하나를 `rm -rf`한다(안의 링크는 따라가지 않고 링크만 지운다).
 */
export const BASELINE_SCRIPT = [
  'set -u',
  'W=$(pwd -P) || exit 70',
  'B=$(mktemp -d "${TMPDIR:-/tmp}/b-studio-baseline.XXXXXX") || exit 70',
  '[ -n "$B" ] && [ -d "$B" ] || exit 70',
  'trap \'rm -rf "$B"\' EXIT',
  "trap 'exit 143' HUP INT TERM",
  'case "$B/" in "$W"/*) exit 72;; esac',
  'cp -a "$W/." "$B/" || exit 71',
  'cd "$B" || exit 70',
  'while IFS=" " read -r op mode p c; do',
  '  [ -n "$op" ] || continue',
  '  rel=$(printf %s "$p" | base64 -d) || exit 73',
  '  case "$rel" in ""|/*|..|../*|*/..|*/../*) exit 73;; esac',
  '  d=$(dirname "./$rel")',
  '  while [ "$d" != "." ] && [ "$d" != "/" ]; do',
  '    [ -L "$d" ] && exit 74',
  '    d=$(dirname "$d")',
  '  done',
  '  f="./$rel"',
  '  [ -d "$f" ] && [ ! -L "$f" ] && exit 75',
  '  rm -f "$f" || exit 75',
  '  if [ "$op" = W ]; then',
  '    mkdir -p "$(dirname "$f")" || exit 75',
  '    printf %s "$c" | base64 -d > "$f" || exit 75',
  '    if [ "$mode" = x ]; then chmod 755 "$f" || exit 75; else chmod 644 "$f" || exit 75; fi',
  '  fi',
  'done',
  `printf '%s\\n' ${BASELINE_READY_MARK}`,
  '"$@"',
  'rc=$?',
  'exit "$rc"',
].join('\n');

export function baselineInput(files: readonly BaselineFile[]): string {
  const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64');
  return files.map((file) => (file.content === null ? `D - ${b64(file.path)} \n` : `W ${file.executable ? 'x' : '-'} ${b64(file.path)} ${file.content.toString('base64')}\n`)).join('');
}

/**
 * 같은 서비스 컨테이너에서 변경 전 나무에 시험 명령을 돌려 라벨을 정한다. 던지지 않는다.
 * `before`는 "표시를 받았고(시험이 실제로 시작했다) 0이 아닌 코드로 끝났고 명령을 찾지 못한 코드(126·127)가 아닐 때"뿐이다
 */
export async function runAtBaseline(
  sandbox: Pick<Sandbox, 'exec'>,
  service: string,
  command: readonly string[],
  snapshot: BaselineSnapshot,
  options: { signal?: AbortSignal | undefined; timeoutMs: number },
): Promise<BaselineLabel> {
  if (snapshot.kind !== 'ok') return { label: 'unknown', reason: snapshot.reason };
  if (command.length === 0) return { label: 'unknown', reason: 'setup-failed' };
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let result;
  try {
    result = await sandbox.exec(service, ['sh', '-c', BASELINE_SCRIPT, 'sh', ...command], { signal, input: baselineInput(snapshot.files) });
  } catch {
    if (options.signal?.aborted) return { label: 'unknown', reason: 'aborted' };
    return { label: 'unknown', reason: timeout.aborted ? 'timeout' : 'platform' };
  }
  // 시험이 돌기 전에 멈췄으면(복사·되돌리기 실패, 셸·base64 없음 등) 표시가 없다. 그 종료 코드는 시험의 것이 아니다
  if (!result.stdout.startsWith(`${BASELINE_READY_MARK}\n`)) return { label: 'unknown', reason: 'setup-failed' };
  if (result.exitCode === 0) return { label: 'now' };
  if (typeof result.exitCode !== 'number' || NOT_RUNNABLE_CODES.has(result.exitCode)) return { label: 'unknown', reason: 'setup-failed' };
  return { label: 'before' };
}

type StoreLike = Pick<CheckpointStore, 'pendingChanges' | 'blobAt' | 'pendingExcludedFiles'>;

/**
 * 체크포인트 저장소에서 기준을 모은다. 기준은 서버가 아는 마지막 체크포인트(`checkpointSha`)다 — 저장소의 HEAD가 아니다.
 * 다음이면 기준을 만들지 않고 `unknown`이다(정확한 변경 전 나무를 약속할 수 없다):
 * 체크포인트가 없음, 체크포인트가 추적하지 않는 생성 파일이 바뀜(`pendingExcludedFiles`: 되돌릴 내용이 없다), 링크·서브모듈이 바뀜, 파일이 너무 많거나 큼, git이 실패함
 */
export function baselineFromCheckpoints(store: StoreLike, checkpointSha: () => string | undefined): BaselineSource {
  return {
    async load(): Promise<BaselineSnapshot> {
      const sha = checkpointSha();
      if (!sha) return { kind: 'unknown', reason: 'no-baseline' };
      try {
        const changes = await store.pendingChanges();
        if (changes.length > MAX_BASELINE_FILES) return { kind: 'unknown', reason: 'too-large' };
        if ((await store.pendingExcludedFiles()).length > 0) return { kind: 'unknown', reason: 'untracked-changes' };
        const files: BaselineFile[] = [];
        let bytes = 0;
        for (const { file } of changes) {
          const blob = await store.blobAt(file, sha);
          if (blob.kind === 'unsupported') return { kind: 'unknown', reason: 'unsupported-file' };
          if (blob.kind === 'file') {
            bytes += blob.content.length;
            if (bytes > MAX_BASELINE_BYTES) return { kind: 'unknown', reason: 'too-large' };
            files.push({ path: file, content: blob.content, executable: blob.executable });
          } else {
            files.push({ path: file, content: null, executable: false });
          }
        }
        return { kind: 'ok', files };
      } catch {
        return { kind: 'unknown', reason: 'setup-failed' };
      }
    },
  };
}
