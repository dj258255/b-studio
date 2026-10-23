/**
 * 여러 AI 계정 API(#885)가 함께 쓰는 확인. 계정 연결(ADR-093)과 같은 이유로 이 서버의 CLI를 그대로 쓰는 개인 PC 모드에서만 연다.
 */
import { requireUser } from './access';
import { findAiAccount, type AiAccount } from './ai-accounts';
import { CLI_ACCOUNT_BACKENDS, type CliAccountBackend } from './cli-accounts';
import { StudioError } from './errors';
import { allowedBackends, localFolderAllowed } from './sessions';

export function requireAccountsAccess(request: Request): void {
  requireUser(request.headers);
  if (!localFolderAllowed()) throw new StudioError(403, '계정은 개인 PC 모드(로컬 CLI)에서만 씁니다');
}

/** 이 서버가 허용하는 CLI 백엔드(B_STUDIO_MODE + B_STUDIO_BACKENDS 중 계정이 있는 것) */
export function allowedAccountBackends(): CliAccountBackend[] {
  const allowed = allowedBackends() as Set<string>;
  return CLI_ACCOUNT_BACKENDS.filter((backend) => allowed.has(backend));
}

export async function requireAccount(id: string): Promise<AiAccount> {
  const account = await findAiAccount(id);
  if (!account) throw new StudioError(404, '그 계정이 목록에 없습니다');
  return account;
}
