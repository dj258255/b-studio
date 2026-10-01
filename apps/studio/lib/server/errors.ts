import { CheckpointError, WorkspaceError } from '@b-studio/agent';
import { SecretError } from '@b-studio/sandbox';
import { SpecError } from '@b-studio/spec';
import { FigmaError } from './figma';

/** 라우트 핸들러가 HTTP 상태로 바꿔 돌려줄 수 있는 오류 */
export class StudioError extends Error {
  readonly status: number;
  /** 화면에는 접은 상태로 두고 펼쳤을 때만 보여줄 원문(예: 커맨드가 돌려준 원래 오류 메시지). 없으면 message만 보여준다 */
  readonly details: string | undefined;

  constructor(status: number, message: string, details?: string) {
    super(message);
    this.name = 'StudioError';
    this.status = status;
    this.details = details;
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof StudioError) return Response.json({ error: error.message, details: error.details }, { status: error.status });
  // Figma 오류 문구에는 토큰 값이 들어가지 않는다(원인별 안내만 담는다)
  if (error instanceof FigmaError) return Response.json({ error: error.message }, { status: error.status });
  // 시크릿 오류 메시지에는 이름과 이유만 있고 값은 없다. 작업 공간 오류는 프로젝트 밖 경로나 비밀 파일을 요청한 경우다
  if (error instanceof SpecError || error instanceof CheckpointError || error instanceof SecretError || error instanceof WorkspaceError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error('[b-studio]', error);
  return Response.json({ error: error instanceof Error ? error.message : '알 수 없는 오류' }, { status: 500 });
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
