export class SandboxError extends Error {
  /** docker 등 하위 도구가 남긴 원본 출력 */
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(detail ? `${message}\n${detail.trim()}` : message);
    this.name = 'SandboxError';
    this.detail = detail;
  }
}
