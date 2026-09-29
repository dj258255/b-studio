import { isProtectedPath, Workspace, WorkspaceError } from '@b-studio/agent';
import type { LoadedProject } from '@b-studio/spec';
import { safeName } from './artifacts';
import { StudioError } from './errors';

/**
 * 가져온 Figma 프레임을 세션 작업 복사본의 `design/<이름>.png`로 둔다.
 * 서버가 몰래 쓰지 않고 세션 변경으로 남겨, 체크포인트와 게이트를 탄다(=되돌리기·PR에 함께 실린다).
 * 저장 경로는 파일 도구와 같은 Workspace 경로 규칙을 거치고, 보호 경로(workflow.protectedPaths)는 거부한다
 */
export function designPathFor(frame: { name: string }): string {
  return `design/${safeName(frame.name)}.png`;
}

/** 보호 경로가 아니면 프로젝트 안에 PNG를 쓴다. 경로 탈출·보호 경로는 StudioError(400)로 거부한다 */
export async function writeDesignPng(project: LoadedProject, relative: string, png: Buffer): Promise<void> {
  for (const rule of project.spec.workflow?.protectedPaths ?? []) {
    if (isProtectedPath(relative, rule)) throw new StudioError(400, `${relative}: 보호 경로(${rule})에는 디자인을 저장할 수 없습니다`);
  }
  try {
    await new Workspace(project.root).writeBinary(relative, png);
  } catch (error) {
    if (error instanceof WorkspaceError) throw new StudioError(400, error.message);
    throw error;
  }
}

/** pageChecks.compare 예시 줄. viewport는 프레임 크기, reference는 저장 경로 */
export function compareExample(relative: string, frame: { width: number; height: number }): string {
  return `pageChecks:\n  - service: web\n    path: /\n    mode: browser\n    viewport: { width: ${frame.width}, height: ${frame.height} }\n    compare:\n      reference: ${relative}\n      maxDiffRatio: 0.15`;
}
