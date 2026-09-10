import type { LoadedProject } from '@b-studio/spec';

export interface FileServiceMapping {
  /** 바뀐 파일이 속한 managed 서비스 (중복 없음, studio.yaml 순서) */
  services: string[];
  /** 어느 서비스에도 속하지 않는 파일 (compose.yaml 등) */
  unmatched: string[];
}

/** 바뀐 파일 경로를 보고 다시 띄워야 할 서비스를 고른다 */
export function servicesForFiles(project: LoadedProject, files: readonly string[]): FileServiceMapping {
  const hit = new Set<string>();
  const unmatched: string[] = [];

  for (const file of files) {
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

function normalize(servicePath: string): string {
  return servicePath.replace(/^\.\/?/, '').replace(/\/+$/, '');
}
