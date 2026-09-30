import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { getSessionRequirementsMatrix, getSessionRequirementsMatrixCsv } from '@/lib/server/sessions';

/**
 * 추적 매트릭스(ADR-090): 요구사항·시나리오 행마다 개정·우선순위·이슈·커밋·테스트·게이트·상태를 모으고, "주인 없는
 * 테스트"·"테스트 없는 필수 요구사항" 역방향 목록을 함께 돌려준다. `?format=csv`면 CSV 파일로 내려받는다("CSV로 내보내기" 버튼).
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/requirements/matrix'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const format = new URL(request.url).searchParams.get('format');
    if (format === 'csv') {
      const csv = await getSessionRequirementsMatrixCsv(id);
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="requirements-matrix-${id}.csv"`,
        },
      });
    }
    return Response.json(await getSessionRequirementsMatrix(id));
  } catch (error) {
    return errorResponse(error);
  }
}
