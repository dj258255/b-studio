import { errorResponse, StudioError } from '@/lib/server/errors';
import { phoneGateway } from '@/lib/server/phone/listener';
import { assertPhoneManager } from '@/lib/server/phone/manage';
import { getDevice, removeDevice } from '@/lib/server/phone/state';
import { authConfig } from '@/lib/server/auth';

/** 기기를 끊는다. 그 기기의 열린 세션과 흐름이 그 자리에서 닫히고, 다음 요청부터 거절된다. 짝을 맺은 사람이나(인증을 켠 서버는) 관리자만 끊는다 */
export async function DELETE(request: Request, context: RouteContext<'/api/phone/devices/[id]'>) {
  try {
    const user = assertPhoneManager(request.headers);
    const { id } = await context.params;
    const device = getDevice(id);
    const config = authConfig();
    if (!device || (config.mode !== 'none' && device.user !== user && !config.admins.has(user))) throw new StudioError(404, '그 기기를 찾을 수 없습니다');
    const gateway = phoneGateway();
    if (gateway) gateway.revokeDevice(id);
    else removeDevice(id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
