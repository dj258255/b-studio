import { DockerDeployer, type DeployStatus } from '@b-studio/sandbox';
import { StudioError } from './errors';
import { findProject } from './projects';
import { getSnapshot, recoverSessions } from './sessions';

/** 세션의 프로젝트가 운영 중인 배포. 배포는 세션이 아니라 프로젝트 단위라, 중지한 세션에서도 볼 수 있다 */
export async function sessionDeployStatus(id: string): Promise<DeployStatus> {
  await recoverSessions();
  const snapshot = getSnapshot(id);
  if (!snapshot) throw new StudioError(404, '세션을 찾을 수 없습니다');
  const project = await findProject(snapshot.projectId);
  if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  return new DockerDeployer(project).status();
}
