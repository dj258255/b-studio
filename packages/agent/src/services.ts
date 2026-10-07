import path from 'node:path';
import { SPEC_FILE, type LoadedProject } from '@b-studio/spec';

export interface FileServiceMapping {
  /** 바뀐 파일이 속한 managed 서비스 (중복 없음, studio.yaml 순서) */
  services: string[];
  /** 어느 서비스에도 속하지 않는 파일(어떤 서비스에도 매인 폴더가 아닌 파일) */
  unmatched: string[];
}

/**
 * 바뀐 파일 경로를 보고 다시 띄워야 할 서비스를 고른다.
 * studio.yaml·compose 파일은 특정 서비스 폴더에 속하지 않지만 모든 managed 서비스의 환경 변수·마운트·
 * top-level configs를 결정한다. 둘 중 하나만 재시작하면 나머지는 옛 설정을 그대로 쓰게 되므로(트러블슈팅 72),
 * 바뀌면 managed 서비스를 전부 다시 띄운다
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
    const owner = project.managed.find(([, service]) => {
      const root = normalize(service.path);
      return root === '' || file === root || file.startsWith(`${root}/`);
    });
    if (owner) hit.add(owner[0]);
    else unmatched.push(file);
  }

  return {
    services: project.managed.map(([name]) => name).filter((name) => hit.has(name)),
    unmatched,
  };
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
