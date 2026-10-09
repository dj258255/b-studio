export class SandboxError extends Error {
  /** docker 등 하위 도구가 남긴 원본 출력 */
  readonly detail: string | undefined;
  /**
   * 샌드박스·도커 쪽 문제라 사용자의 코드를 고쳐서는 풀 수 없는 실패(준비 단계 오류, 도커에 닿지 못함, 파일 반영 불가 등).
   * 서비스가 뜨지 않은 것처럼 코드가 원인일 수 있는 실패에는 붙이지 않는다. 애매하면 붙이지 않는다 —
   * 붙이면 게이트가 재시도 횟수로 세지 않고 에이전트의 변경을 되돌리지 않기 때문이다(도그푸딩 마찰 187, 트러블슈팅 117)
   */
  readonly platform: boolean;

  constructor(message: string, detail?: string, options: { platform?: boolean } = {}) {
    super(detail ? `${message}\n${detail.trim()}` : message);
    this.name = 'SandboxError';
    this.detail = detail;
    this.platform = options.platform === true;
  }
}

/** docker 명령의 오류 출력이 "도커 데몬에 닿지 못했다"는 뜻인지. 닿지 못한 것은 코드로 고칠 수 없다 */
export function isDockerUnreachable(stderr: string): boolean {
  return /Cannot connect to the Docker daemon|error during connect|docker daemon is not running|dial unix [^\n]*docker\.sock[^\n]*(no such file|connection refused)/i.test(stderr);
}
