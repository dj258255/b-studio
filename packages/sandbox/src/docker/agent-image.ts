import { execChecked } from '../exec-checked';

/**
 * 컨테이너 방식 세션 터미널의 codex용 에이전트 이미지(ADR-245). 기본 이미지에 codex CLI를 에이전트가 쓸 수 없는 자리(/opt/b-studio, root 소유)에 더한 것이다.
 * Dockerfile은 packages/sandbox/agent-image/Dockerfile, 빌드는 사람이 `pnpm agent-image:build`로 한다(시험·CI는 만들지 않는다).
 * Dockerfile이나 codex 판을 바꾸면 이름의 숫자를 올린다 — 옛 이름의 이미지가 남아 있어도 새 판으로 착각하지 않는다.
 * build.sh가 아래 줄을 그대로 읽으므로 한 줄 꼴을 지킨다
 */
export const AGENT_CODEX_IMAGE = 'b-studio-agent-codex:1';
/** 이미지 안 codex 실행 파일. 읽기 전용 루트 파일 시스템 위의 root 소유 자리라 에이전트가 바꿀 수 없다 */
export const AGENT_CODEX_BIN = '/opt/b-studio/codex/bin/codex';

/**
 * 이 도커에 이미지가 있는가. 없으면 `docker run`이 이름을 레지스트리에서 찾으려다 모호한 오류로 끝나므로 열기 전에 묻는다.
 * 확인하지 못하면(도커가 답하지 않음) "없다"로 답한다 — 모르는 것을 있다고 하지 않는다
 */
export async function agentImageExists(image: string, { dockerBin = 'docker' }: { dockerBin?: string } = {}): Promise<boolean> {
  try {
    await execChecked(dockerBin, ['image', 'inspect', '--format', '{{.Id}}', image]);
    return true;
  } catch {
    return false;
  }
}
