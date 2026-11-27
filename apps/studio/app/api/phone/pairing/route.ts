import { hostname } from 'node:os';
import { errorResponse } from '@/lib/server/errors';
import { cancelPairing } from '@/lib/server/phone/state';
import { assertPhoneManager, newPairingPayload } from '@/lib/server/phone/manage';

/** 새 짝 코드와 QR에 담을 내용. 코드는 2분 동안 한 번만 쓰고, 새로 만들면 앞의 코드는 못 쓴다. 코드의 주인은 이 요청의 사용자다 */
export async function POST(request: Request) {
  try {
    const user = assertPhoneManager(request.headers);
    return Response.json(newPairingPayload(user, hostname()));
  } catch (error) {
    return errorResponse(error);
  }
}

/** 보이던 QR을 거두면 코드도 그 자리에서 못 쓰게 한다 */
export async function DELETE(request: Request) {
  try {
    cancelPairing(assertPhoneManager(request.headers));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
