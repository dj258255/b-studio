import { CheckpointError } from '@b-studio/agent';
import { SpecError } from '@b-studio/spec';

/** 라우트 핸들러가 HTTP 상태로 바꿔 돌려줄 수 있는 오류 */
export class StudioError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'StudioError';
    this.status = status;
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof StudioError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SpecError || error instanceof CheckpointError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error('[b-studio]', error);
  return Response.json({ error: error instanceof Error ? error.message : '알 수 없는 오류' }, { status: 500 });
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
