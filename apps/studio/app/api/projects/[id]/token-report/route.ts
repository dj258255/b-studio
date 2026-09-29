import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { projectTokenMarkdown, projectTokenReport } from '@/lib/server/project-token-report';

/**
 * 프로젝트의 모든 세션 토큰·비용·절약량 보고서.
 * `?format=markdown`이면 과제 README에 그대로 붙일 수 있는 마크다운 본문을 주고, `?download=1`이면 파일로 내려준다.
 * 보기는 로그인한 누구나 할 수 있다(ADR-040). 세션 기록을 바꾸지 않는다.
 */
export async function GET(request: Request, context: RouteContext<'/api/projects/[id]/token-report'>) {
  try {
    const viewer = requireUser(request.headers);
    const { id } = await context.params;
    const url = new URL(request.url);
    const format = url.searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'markdown') throw new StudioError(400, 'format은 json 또는 markdown이어야 합니다');
    const report = await projectTokenReport(id, {
      viewer,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    });
    if (format === 'json') return Response.json({ report });
    const filename = `b-studio-token-report-${report.projectId}-${report.generatedAt.slice(0, 10)}.md`;
    return new Response(projectTokenMarkdown(report), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${filename}"`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
