import path from 'node:path';
import type { FileChange } from '../types';

/** 알림을 만들려고 잠깐 쓰는 이름의 접두사. 파일 감시와 체크포인트에서 뺀다 */
export const RELAY_PREFIX = '.b-studio-relay-';

/**
 * 컨테이너 안에서 파일 감시기가 알아챌 변경을 만든다. 컨테이너 커널을 거친 변경이라 감시기에 알림이 간다.
 * - "m:<경로>": 새 폴더를 옆 이름으로 옮겼다가 되돌린다. 목록을 다시 읽게 하는 것만으로는 새 폴더를 찾지 못했다
 * - "n:<폴더>": 폴더에 숨긴 임시 폴더를 만들었다 지워 목록을 다시 읽게 한다. 새 파일과 지운 경로에 쓰고, 사용자 파일은 건드리지 않는다
 * 인자는 셸 문자열에 끼워 넣지 않고 위치 인자로 넘긴다. 알린 인자를 한 줄씩 출력한다
 */
export const RELAY_SCRIPT = [
  'status=0',
  'for arg do',
  '  p=${arg#?:}',
  '  case "$arg" in',
  '    m:*)',
  '      [ -d "$p" ] || continue',
  `      t="\${p%/*}/${RELAY_PREFIX}$$-\${p##*/}"`,
  '      mv -- "$p" "$t" || { status=1; continue; }',
  // 옮긴 사이에 같은 이름이 다시 생겼으면 덮어쓰지 않고 옆 이름으로 남긴다
  `      if [ -e "$p" ]; then mv -- "$t" "$p${RELAY_PREFIX}kept" || status=1; else mv -- "$t" "$p" || status=1; fi`,
  '      ;;',
  '    n:*)',
  '      [ -d "$p" ] || continue',
  `      t="$p/${RELAY_PREFIX}$$"`,
  '      { mkdir -- "$t" && rmdir -- "$t"; } || { status=1; continue; }',
  '      ;;',
  '    *) continue ;;',
  '  esac',
  '  printf "%s\\n" "$arg"',
  'done',
  'exit $status',
].join('\n');

export interface BindMount {
  service: string;
  managed: boolean;
  /** 호스트 절대 경로 */
  source: string;
  /** 컨테이너 안 절대 경로 */
  target: string;
  /**
   * 이 서비스가 실제로 일하는 하위 폴더(호스트 절대 경로, servicePaths로 알려줬을 때만).
   * ADR-088 이후로는 여러 서비스가 같은 프로젝트 루트를 통째로 마운트해 source가 같아지므로,
   * source 길이만으로는 더 좁게 겹치는 서비스를 가릴 수 없다 — 이 값으로 한 번 더 좁힌다
   */
  subroot?: string;
}

export interface RelayTarget {
  action: 'move' | 'nudge';
  /** 컨테이너 안 절대 경로. move는 새 폴더, nudge는 목록을 다시 읽게 할 폴더 */
  containerPath: string;
  /** 이 알림으로 전하는 프로젝트 기준 경로 */
  files: string[];
}

/**
 * `docker compose config --format json` 결과에서 바인드 마운트만 모은다.
 * `servicePaths`(서비스 이름 → 프로젝트 루트 기준 상대 경로)를 주면, ADR-088처럼 여러 서비스가 같은 루트를
 * 통째로 마운트해도 각 서비스의 subroot(실제 작업 폴더)를 함께 계산해 둔다
 */
export function bindMounts(
  services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string }> }>,
  managed: ReadonlySet<string>,
  servicePaths: Readonly<Record<string, string>> = {},
): BindMount[] {
  return Object.entries(services).flatMap(([service, spec]) =>
    (spec.volumes ?? [])
      .filter((volume) => volume.type === 'bind' && volume.source)
      .map((volume) => {
        const source = path.resolve(volume.source!);
        const servicePath = servicePaths[service];
        return {
          service,
          managed: managed.has(service),
          source,
          target: volume.target,
          ...(servicePath !== undefined ? { subroot: servicePath === '.' ? source : path.resolve(source, servicePath) } : {}),
        };
      }),
  );
}

/**
 * 바뀐 경로를 서비스별 알림으로 바꾼다.
 * - 새 폴더는 옮긴다. 마운트 폴더 자체나 그 상위는 옮기면 서비스의 마운트가 흔들리므로 옮기지 않고 부모 목록만 다시 읽게 한다
 * - 옮기는 새 폴더 안의 경로와, 지운 폴더 안의 경로는 따로 알리지 않는다
 * - 새 파일과 지운 경로는 부모 폴더 하나에 한 번만 알린다
 * - 여러 서비스가 마운트하면 managed 서비스, 그다음 더 좁게 마운트한 서비스의 컨테이너에서 알린다
 */
export function planRelay(projectRoot: string, changes: readonly FileChange[], mounts: readonly BindMount[]): Map<string, RelayTarget[]> {
  const root = path.resolve(projectRoot);
  const latest = new Map<string, FileChange['kind']>();
  for (const change of changes) {
    const file = change.file.replace(/\/+$/, '');
    if (file) latest.set(file, change.kind);
  }
  const entries = [...latest]
    .map(([file, kind]) => ({ file, kind, absolute: path.resolve(root, file) }))
    .filter(({ absolute }) => isInside(root, absolute) && absolute !== root)
    .sort((a, b) => a.file.localeCompare(b.file));
  const moved = entries.filter(({ kind, absolute }) => kind === 'directory' && !mounts.some((mount) => isInside(absolute, mount.source)));
  const deleted = entries.filter(({ kind }) => kind === 'deleted');

  const plan = new Map<string, RelayTarget[]>();
  for (const entry of entries) {
    if (moved.some((dir) => dir !== entry && isInside(dir.absolute, entry.absolute))) continue;
    if (entry.kind === 'deleted' && deleted.some((dir) => dir !== entry && isInside(dir.absolute, entry.absolute))) continue;

    const action = moved.includes(entry) ? 'move' : 'nudge';
    const target = action === 'move' ? entry.absolute : path.dirname(entry.absolute);
    const mount = mounts
      .filter((candidate) => isInside(candidate.source, target))
      .sort((a, b) => Number(b.managed) - Number(a.managed) || subrootScore(b, target) - subrootScore(a, target) || b.source.length - a.source.length)[0];
    if (!mount) continue;

    const containerPath = path.posix.join(mount.target, path.relative(mount.source, target).split(path.sep).join('/'));
    const targets = plan.get(mount.service) ?? [];
    const existing = targets.find((candidate) => candidate.action === action && candidate.containerPath === containerPath);
    if (existing) existing.files.push(entry.file);
    else targets.push({ action, containerPath, files: [entry.file] });
    plan.set(mount.service, targets);
  }
  return plan;
}

/** subroot가 target을 실제로 감싸면 그 길이를(더 좁을수록 큰 점수), 아니면(subroot가 없거나 target 밖이면) -1을 돌려준다 */
function subrootScore(mount: BindMount, target: string): number {
  return mount.subroot && isInside(mount.subroot, target) ? mount.subroot.length : -1;
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
