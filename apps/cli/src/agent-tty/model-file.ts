import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { apiKeyEnvName, validateModelProfiles, type ModelProfile } from '@b-studio/agent';

export const MODEL_FILE_NAME = 'agent-model.json';

export interface LoadedModel {
  profile: ModelProfile;
  /** 클라이언트에만 넘기는 환경. 키는 여기에만 있고 process.env·인자·출력에는 넣지 않는다 */
  env: Record<string, string>;
}

export class ModelFileError extends Error {}

/** 모델 파일은 `--settings` 파일과 같은 폴더에 둔다(서버가 같은 폴더에 600으로 쓴다) */
export function modelFilePath(settingsFile: string): string {
  return path.join(path.dirname(path.resolve(settingsFile)), MODEL_FILE_NAME);
}

/**
 * 모델 파일을 읽는다(fail closed): 없음·읽을 수 없음·일반 파일이 아님·그룹/다른 사용자 권한 있음·JSON이 아님·
 * 모델 설정 검증 실패는 모두 사유와 함께 ModelFileError로 던진다. 키가 든 파일이라 600이 아니면 읽지 않는다
 */
export function loadModelFile(file: string): LoadedModel {
  // 한 번 연 핸들로 확인하고 읽는다: 경로로 확인한 뒤 다시 경로로 읽으면 그 사이에 바꿔친 파일을 읽을 수 있다.
  // O_NOFOLLOW라 마지막 조각이 링크면 열지 않는다(ELOOP)
  let fd: number;
  try {
    // O_NONBLOCK: FIFO 같은 특수 파일에서 열기가 멈추지 않게 한다(종류는 아래 fstat에서 거절한다)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new ModelFileError(`모델 파일이 일반 파일이 아닙니다(링크는 허용하지 않습니다): ${file}`);
    throw new ModelFileError(`모델 파일이 없거나 읽을 수 없습니다: ${file}`);
  }
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ModelFileError(`모델 파일이 일반 파일이 아닙니다(링크는 허용하지 않습니다): ${file}`);
    // 다른 사용자가 심은 파일은 600이어도 믿지 않는다(키·모델 주소를 바꿔치기할 수 있다)
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) throw new ModelFileError(`모델 파일의 주인이 이 사용자가 아닙니다: ${file}`);
    if ((stat.mode & 0o077) !== 0) throw new ModelFileError(`모델 파일의 권한이 600이 아닙니다(그룹·다른 사용자 권한이 있습니다): ${file}`);
    try {
      raw = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new ModelFileError(`모델 파일이 올바른 JSON이 아닙니다: ${file}`);
    }
  } finally {
    closeSync(fd);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ModelFileError('모델 파일은 {"profile": …} 꼴의 객체여야 합니다');
  const { profile: rawProfile, apiKey: rawKey } = raw as { profile?: unknown; apiKey?: unknown };
  if (rawKey !== undefined && typeof rawKey !== 'string') throw new ModelFileError('모델 파일의 apiKey는 문자열이어야 합니다');
  // 클라이언트가 다듬어 읽으므로 같은 규칙으로 읽는다: 공백뿐인 키는 없는 키다
  const apiKey = rawKey?.trim() || undefined;
  let profile: ModelProfile;
  try {
    const [validated] = validateModelProfiles([rawProfile]);
    if (!validated) throw new Error('모델 설정이 비어 있습니다');
    profile = validated;
  } catch (error) {
    throw new ModelFileError(`모델 파일의 모델 설정이 올바르지 않습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Anthropic SDK는 키를 받지 못하면 process.env의 키로 조용히 대신한다. 그 키가 파일의 baseUrl로 가지 않게 키 없는 anthropic 설정은 거절한다
  // (다른 공급자의 클라이언트는 키가 없으면 로컬 주소가 아닌 한 스스로 던진다)
  if (profile.provider === 'anthropic' && !apiKey) throw new ModelFileError('anthropic 모델에는 모델 파일의 apiKey가 필요합니다');
  return { profile, env: apiKey ? { [apiKeyEnvName(profile)]: apiKey } : {} };
}
