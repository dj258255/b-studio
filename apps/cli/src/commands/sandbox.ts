import { styleText } from 'node:util';
import { pruneSandboxLeftovers, type PruneResult, type SandboxLeftovers } from '@b-studio/sandbox';

const KINDS: ReadonlyArray<[keyof SandboxLeftovers, string]> = [
  ['containers', '컨테이너'],
  ['images', '이미지'],
  ['volumes', '볼륨'],
  ['networks', '네트워크'],
];

/** b-studio와 무관해 이름을 나열하지 않고 개수만 세는 건너뜀 이유 */
const COUNT_ONLY_REASON = 'compose 라벨 없음';

/** 이유별로 이름을 보여 주는 최대 개수. 넘으면 `외 N개` 로 줄인다 */
const MAX_NAMES = 10;

function count(leftovers: SandboxLeftovers): number {
  return KINDS.reduce((sum, [kind]) => sum + leftovers[kind].length, 0);
}

function printLeftovers(leftovers: SandboxLeftovers, verb: string): void {
  if (count(leftovers) === 0) return;
  console.log(`${verb} 남은 샌드박스 자원 ${count(leftovers)}개:`);
  for (const [kind, label] of KINDS) {
    if (leftovers[kind].length === 0) continue;
    console.log(`  ${label} ${leftovers[kind].length}개`);
    for (const name of leftovers[kind]) console.log(`    ${name}`);
  }
}

/**
 * 건너뛴 자원을 이유별로 묶어 개수부터 한 줄로 보여 준다.
 * `compose 라벨 없음` 처럼 b-studio와 무관한 이유는 개수만 세고, 이름은 b-studio 자원인
 * 이유(공유 캐시 볼륨·실행 중·삭제 실패)에만 이유당 최대 10개까지 보여 주고 나머지는 `외 N개` 로 줄인다
 */
function printSkipped(skipped: PruneResult['skipped']): void {
  if (skipped.length === 0) return;

  const groups = new Map<string, string[]>();
  for (const { resource, reason } of skipped) {
    const names = groups.get(reason);
    if (names) names.push(resource);
    else groups.set(reason, [resource]);
  }

  console.log(`건너뜀: ${[...groups].map(([reason, names]) => `${reason} ${names.length}개`).join(', ')}`);
  for (const [reason, names] of groups) {
    if (reason === COUNT_ONLY_REASON) continue;
    const rest = names.length - MAX_NAMES;
    const shown = names.slice(0, MAX_NAMES).join(', ');
    console.log(styleText('dim', `    ${reason}: ${shown}${rest > 0 ? ` 외 ${rest}개` : ''}`));
  }
}

/**
 * b-studio가 만들었지만 쓰지 않는 Docker 자원을 찾아 지운다.
 * 먼저 지울 목록을 보여 주고, `--dry-run` 이면 목록만 보여 주고 아무것도 지우지 않는다.
 * 수집은 `pruneSandboxLeftovers` 안에서 한 번만 하므로, 보여 준 목록 밖의 자원을 지우지 않는다
 */
export async function sandboxPrune({ dryRun }: { dryRun: boolean }): Promise<number> {
  let nothingToPrune = true;
  const { removed, skipped } = await pruneSandboxLeftovers({
    dryRun,
    onFound: (found) => {
      nothingToPrune = count(found) === 0;
      printLeftovers(found, dryRun ? '지울' : '정리할');
    },
  });

  printSkipped(skipped);

  if (nothingToPrune) {
    console.log('정리할 남은 자원이 없습니다');
    return 0;
  }

  if (dryRun) {
    console.log(styleText('dim', '--dry-run: 아무것도 지우지 않았습니다'));
    return 0;
  }

  console.log(`지웠습니다: ${count(removed)}개`);
  return 0;
}
