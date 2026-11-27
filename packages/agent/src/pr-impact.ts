import type { LoadedProject } from '@b-studio/spec';
import type { SessionCommit } from './checkpoints';
import type { PullRequestImpact } from './repository';
import { servicesForFiles } from './services';
import { protectedPathsFor } from './workflow';

/**
 * PR 초안의 "영향 범위"·"중점 리뷰 항목" 절이 쓰는 사실 중 프로젝트 선언에서 오는 것을 모은다. 절을 쓰는 것은 Rust
 * (crates/bstudio-guard/src/repository.rs)이고, 여기서는 서비스 소유 판정(servicesForFiles)과 보호 경로 규칙만 넘긴다.
 * gateCheckpoints는 서버가 게이트를 거쳐 만든 체크포인트의 sha들이다. 서비스 판정이 던지면 빈 목록이 아니라 null이다: "서비스 없음"과 "모름"을 PR 본문에서 구분해야 한다
 */
export function pullRequestImpactFor(project: LoadedProject, commits: readonly Pick<SessionCommit, 'files'>[], gateCheckpoints: Iterable<string> = []): PullRequestImpact {
  const files = [...new Set(commits.flatMap((commit) => commit.files))];
  let services: string[] | null = null;
  let unmatchedFiles: number | null = null;
  try {
    const mapping = servicesForFiles(project, files);
    services = mapping.services;
    unmatchedFiles = mapping.unmatched.length;
  } catch {
    // 서비스를 판정하지 못했다. 본문에 "확인하지 못함"으로 적는다
  }
  return { services, unmatchedFiles, protectedPaths: protectedPathsFor(project.spec.workflow), gateCheckpoints: [...gateCheckpoints] };
}
