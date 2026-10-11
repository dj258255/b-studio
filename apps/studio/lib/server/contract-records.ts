import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * 체크포인트 곁의 API 계약 기록(이슈 #677).
 *
 * 게이트가 체크포인트를 통과시킬 때 실제로 본 계약(서비스 → 계약)을 그 체크포인트의 sha로 남긴다. 다음 실행의 계약 비교가
 * 이것을 기준으로 삼는다 — 작업 복사본에 검증되지 않은 변경이 남아 있을 때 지금 서비스가 내놓는 계약을 기준으로 읽으면,
 * 그 변경이 기준에 들어가 계약을 깨는 변경이 통과한다.
 *
 * 이 기록은 게이트가 믿는 값이다. 그래서 b-studio만 쓰는 자리에 둔다: 세션 상태 폴더의 `.git/b-studio/contracts/`
 * (세션 기록·산출물과 같은 자리 — 컨테이너에서 `.git`은 읽기 전용이고 이 폴더는 가려져 있으며, 로컬 폴더 세션은
 * 사용자 폴더 밖의 세션 폴더다). 사용자가 연 폴더의 저장소 안에는 두지 않는다 — 그 안의 내용은 바깥에서 온 것일 수 있다.
 * 경로의 어느 구간도 링크를 따라가지 않는다: 폴더가 링크면 쓰지도 읽지도 지우지도 않는다.
 */

const DIR = path.join('.git', 'b-studio', 'contracts');
const FULL_SHA = /^[0-9a-f]{40}$/;
const RECORD = /^[0-9a-f]{40}\.json$/;
/** 남겨 둘 기록의 수. 체크포인트 목록보다 넉넉히 둔다 */
const KEEP_MAX = 200;
/** 읽을 기록 하나의 상한. 계약 문서 여럿이 들어가도 이보다 한참 작다 */
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

/**
 * 기록을 두는 폴더의 실제 경로. 링크를 하나라도 거치면(폴더 자체나 그 위의 `.git`·`b-studio`가 링크면) 던진다.
 * create를 주면 없을 때 만든다. 없고 만들지 않으면 undefined
 */
async function recordsDir(stateDir: string, create: boolean): Promise<string | undefined> {
  const dir = path.join(stateDir, DIR);
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir).catch(() => undefined);
  if (!info) return undefined;
  const expected = path.join(await realpath(stateDir), DIR);
  if (!info.isDirectory() || (await realpath(dir)) !== expected) throw new Error('계약 기록 폴더가 폴더가 아니거나 다른 곳을 가리킵니다');
  return expected;
}

/** 체크포인트의 계약을 남긴다. sha는 온전한 커밋 id여야 한다 */
export async function saveContractRecord(stateDir: string, sha: string, contracts: ReadonlyMap<string, unknown>): Promise<void> {
  if (!FULL_SHA.test(sha)) throw new Error('체크포인트 id 형식이 올바르지 않습니다');
  const dir = (await recordsDir(stateDir, true))!;
  const target = path.join(dir, `${sha}.json`);
  // 새 이름으로 "없을 때만" 만들어 쓰고 옮긴다. 미리 놓인 링크나 파일에 덮어쓰지 않고, 읽는 쪽이 반쯤 쓰인 기록을 보지 않는다
  const staged = path.join(dir, `${sha}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(staged, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(Object.fromEntries(contracts)));
  } finally {
    await handle.close();
  }
  await rename(staged, target);
  await prune(dir);
}

/** 체크포인트 곁에 남긴 계약. 남긴 적이 없거나 읽을 수 없으면 undefined(없는 것을 빈 계약으로 읽지 않는다) */
export async function readContractRecord(stateDir: string, sha: string): Promise<Map<string, unknown> | undefined> {
  if (!FULL_SHA.test(sha)) return undefined;
  const dir = await recordsDir(stateDir, false).catch(() => undefined);
  if (!dir) return undefined;
  const target = path.join(dir, `${sha}.json`);
  // 기록 자리에 링크가 놓여 있으면 그 너머를 읽지 않는다
  const info = await lstat(target).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return new Map(Object.entries(parsed));
  } catch {
    return undefined;
  }
}

/** 오래된 기록부터 지운다. 이 폴더 바로 아래의, 기록 이름을 가진 일반 파일만 본다(링크는 건드리지 않는다) */
async function prune(dir: string): Promise<void> {
  const records: Array<{ name: string; at: number }> = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!RECORD.test(name)) continue;
    const info = await lstat(path.join(dir, name)).catch(() => undefined);
    if (info?.isFile()) records.push({ name, at: info.mtimeMs });
  }
  if (records.length <= KEEP_MAX) return;
  for (const { name } of records.sort((a, b) => a.at - b.at).slice(0, records.length - KEEP_MAX)) await unlink(path.join(dir, name)).catch(() => {});
}
