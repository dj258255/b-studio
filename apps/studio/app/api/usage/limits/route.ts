import { homedir } from 'node:os';
import { requireUser } from '@/lib/server/access';
import { listAiAccounts } from '@/lib/server/ai-accounts';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { localFolderAllowed } from '@/lib/server/repo-token';
import { DEFAULT_LIMIT_ACCOUNTS, LIMIT_BACKENDS, limitAccounts, usageLimits } from '@/lib/server/usage-limits';

interface AccountMeta {
  name: string;
  sprite?: string;
  builtin?: boolean;
}

/**
 * 계정마다 구독 한도(5시간·주간)와 상태, 추천 계정(ADR-187). 계정 목록(#885)의 계정 전부를 보고, 이름과 그림을 붙여 돌려준다(#889).
 * 이 컴퓨터의 CLI 로그인 정보를 읽으므로 계정 연결과 같이 개인 PC 모드에서만 연다.
 * `?refresh=1`은 다시 읽기를 청하지만 계정마다 최소 간격(Claude 10분, Codex 1분)은 지킨다
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    if (!localFolderAllowed()) throw new StudioError(403, '구독 한도는 개인 PC 모드(로컬 CLI)에서만 봅니다');
    const refresh = new URL(request.url).searchParams.get('refresh') === '1';
    const meta = new Map<string, AccountMeta>();
    let warning: string | undefined;
    let accounts;
    try {
      const listed = await listAiAccounts(process.env, [...LIMIT_BACKENDS]);
      for (const account of listed) meta.set(account.id, { name: account.name, ...(account.sprite ? { sprite: account.sprite } : {}), ...(account.builtin ? { builtin: true } : {}) });
      accounts = limitAccounts(listed, process.env.HOME?.trim() || homedir());
    } catch (error) {
      // 계정 목록 파일이 깨졌어도 기본 계정들의 한도는 보인다. 까닭은 함께 알린다
      warning = error instanceof Error ? error.message : String(error);
      accounts = DEFAULT_LIMIT_ACCOUNTS;
      for (const account of accounts) meta.set(account.id, { name: '기본', builtin: true });
    }
    const read = await usageLimits().read(accounts, { refresh });
    return Response.json({ accounts: read.map((limits) => ({ ...limits, ...meta.get(limits.id) })), ...(warning ? { warning } : {}) });
  } catch (error) {
    return errorResponse(error);
  }
}
