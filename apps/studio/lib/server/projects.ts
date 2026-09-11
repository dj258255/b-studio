import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadProject, SpecError, type LoadedProject } from '@b-studio/spec';
import type { ProjectSummary } from '@/lib/studio-events';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 스튜디오가 여는 프로젝트들이 있는 폴더. 브라우저에서 임의의 경로를 받지 않고 이 폴더의 하위 폴더만 연다.
 * 실행할 때 정해지는 경로라 turbopackIgnore로 빌드 추적에서 뺀다. 빼지 않으면 standalone 결과물에 저장소 전체가 들어간다
 */
export function projectsRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.B_STUDIO_PROJECTS_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), '../../examples'));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = projectsRoot();
  const entries = await readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true }).catch(() => []);
  const projects: ProjectSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
    try {
      const project = await loadProject(path.join(/*turbopackIgnore: true*/ root, entry.name));
      projects.push({
        id: entry.name,
        name: project.spec.name,
        services: project.managed.map(([name, service]) => ({ name, template: service.template, preview: service.preview })),
      });
    } catch (error) {
      // studio.yaml이 없는 폴더는 프로젝트가 아니다
      if (error instanceof SpecError && error.message.startsWith('파일이 없습니다')) continue;
      projects.push({ id: entry.name, name: entry.name, services: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return projects.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 프로젝트 폴더의 절대 경로. 로컬 폴더 세션을 고르는 화면에 보여 준다 */
export function projectPath(id: string): string {
  return path.join(/*turbopackIgnore: true*/ projectsRoot(), id);
}

export async function findProject(id: string): Promise<LoadedProject | undefined> {
  if (!PROJECT_ID.test(id)) return undefined;
  const project = (await listProjects()).find((candidate) => candidate.id === id && !candidate.error);
  return project ? loadProject(path.join(/*turbopackIgnore: true*/ projectsRoot(), id)) : undefined;
}
