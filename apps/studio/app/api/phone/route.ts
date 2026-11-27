import { hostname } from 'node:os';
import { z } from 'zod';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { setPhoneEnabled } from '@/lib/server/phone/listener';
import { assertPhoneManager, canTogglePhone, phoneView } from '@/lib/server/phone/manage';

/** desk의 휴대폰 연결 화면이 읽는 상태: 켜짐, 귀가 열린 주소, 짝 맺은 기기 */
export async function GET(request: Request) {
  try {
    const user = assertPhoneManager(request.headers);
    return Response.json({ ...phoneView(user), host: hostname() });
  } catch (error) {
    return errorResponse(error);
  }
}

const bodySchema = z.object({ enabled: z.boolean() });

/** 짝짓기 스위치. 켜면 사설 네트워크 주소에 귀를 열고, 끄면 닫고 열린 연결을 모두 버린다 */
export async function POST(request: Request) {
  try {
    const user = assertPhoneManager(request.headers);
    if (!canTogglePhone(user)) throw new StudioError(403, '휴대폰 연결 스위치는 관리자만 바꿉니다');
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, 'enabled가 필요합니다');
    try {
      await setPhoneEnabled(parsed.data.enabled);
    } catch (error) {
      throw new StudioError(409, error instanceof Error ? error.message : String(error));
    }
    return Response.json({ ...phoneView(user), host: hostname() });
  } catch (error) {
    return errorResponse(error);
  }
}
