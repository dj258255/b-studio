import path from 'node:path';
import { SPEC_FILE, type LoadedProject, type ManagedServiceSpec } from '@b-studio/spec';

export interface FileServiceMapping {
  /** 바뀐 파일이 속한 managed 서비스 (중복 없음, studio.yaml 순서) */
  services: string[];
  /** 어느 서비스에도 속하지 않는 파일(어떤 서비스에도 매인 폴더가 아닌 파일) */
  unmatched: string[];
}

/**
 * 바뀐 파일 경로를 보고 다시 띄워야 할 서비스를 고른다.
 * studio.yaml·compose 파일은 특정 서비스 폴더에 속하지 않지만 모든 managed 서비스의 환경 변수·마운트·
 * top-level configs를 결정한다. 둘 중 하나만 재시작하면 나머지는 옛 설정을 그대로 쓰게 되므로(트러블슈팅 74),
 * 바뀌면 managed 서비스를 전부 다시 띄운다.
 *
 * 한 파일이 두 서비스 모두에 속할 수 있다(`path`나 `includes`가 겹치는 경우, 예: 공유 라이브러리 폴더). 첫 번째
 * 소유자만 고르지 않고 겹치는 서비스를 전부 재시작 대상으로 본다 — 재시작을 덜 하는 쪽보다 더 하는 쪽이 안전하다
 * (도그푸딩 마찰 119, ADR-139)
 */
export function servicesForFiles(project: LoadedProject, files: readonly string[]): FileServiceMapping {
  const hit = new Set<string>();
  const unmatched: string[] = [];
  const projectWide = projectWideFiles(project);

  for (const file of files) {
    if (projectWide.has(normalize(file))) {
      for (const [name] of project.managed) hit.add(name);
      if (project.managed.length === 0) unmatched.push(file);
      continue;
    }
    const owners = project.managed.filter(([, service]) => ownsFile(service, file));
    if (owners.length > 0) owners.forEach(([name]) => hit.add(name));
    else unmatched.push(file);
  }

  return {
    services: project.managed.map(([name]) => name).filter((name) => hit.has(name)),
    unmatched,
  };
}

/**
 * 서비스가 이 파일을 소유하는지: 서비스 폴더(`path`) 아래이거나, `includes`로 선언한 폴더 밖 경로 중 하나에
 * 속한다(ADR-139). `uncoveredChangeWarnings`(packages/agent/src/workflow.ts)도 같은 판정을 쓴다 — 매칭 규칙이
 * 두 곳에 따로 있으면 한쪽만 고치고 잊기 쉽다
 */
export function ownsFile(service: Pick<ManagedServiceSpec, 'path' | 'includes'>, file: string): boolean {
  return [service.path, ...(service.includes ?? [])].some((root) => isUnderRoot(file, root));
}

function isUnderRoot(file: string, root: string): boolean {
  const normalized = normalize(root);
  return normalized === '' || file === normalized || file.startsWith(`${normalized}/`);
}

/**
 * studio.yaml과 compose 파일(프로젝트 루트 기준 상대 경로)의 집합.
 * root·composePath가 없는 project(일부 테스트의 최소 fixture)는 compose 쪽을 건너뛴다 — 크래시보다는
 * "예전처럼 매칭 안 함"이 안전하다
 */
function projectWideFiles(project: LoadedProject): Set<string> {
  const files = new Set([SPEC_FILE]);
  if (project.root && project.composePath) files.add(normalize(path.relative(project.root, project.composePath)));
  return files;
}

function normalize(servicePath: string): string {
  return servicePath.replace(/^\.\/?/, '').replace(/\/+$/, '');
}
