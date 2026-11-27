import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { localTokenPath } from './local-token';
import type { DraftSeal } from './session-terminal-draft';

/**
 * 쓰다 만 글의 저장 파일에 찍는 도장의 열쇠(ADR-237). 작업 복사본 밖(로컬 토큰과 같은 폴더, 0700)의 파일 하나에 0600으로 두고 스튜디오를 다시 띄워도 같은 값을 쓴다
 * (로컬 토큰은 시작마다 바뀌어 쓸 수 없다). 에이전트의 도구가 닿는 작업 복사본에는 두지 않는다.
 * 파일이 링크거나 일반 파일이 아니거나 모양이 틀리면 던진다 — 그때는 쓰다 만 글을 저장하지도 되살리지도 않는다
 */
const store = globalThis as typeof globalThis & { __bStudioDraftKey?: Buffer };

function keyPath(env: Record<string, string | undefined>): string {
  return path.join(path.dirname(localTokenPath(env)), 'draft-key');
}

function readKey(file: string): Buffer | undefined {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile() || info.size !== 65) throw new Error('쓰다 만 글의 열쇠 파일이 올바르지 않습니다');
  const text = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error('쓰다 만 글의 열쇠 파일이 올바르지 않습니다');
  return Buffer.from(text, 'hex');
}

export function draftSealKey(env: Record<string, string | undefined> = process.env): Buffer {
  if (store.__bStudioDraftKey) return store.__bStudioDraftKey;
  const file = keyPath(env);
  let key = readKey(file);
  if (!key) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const staged = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(staged, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(staged, file);
    chmodSync(file, 0o600);
    key = readKey(file);
    if (!key) throw new Error('쓰다 만 글의 열쇠를 만들지 못했습니다');
  }
  store.__bStudioDraftKey = key;
  return key;
}

/** 이 파일의 도장. 열쇠를 읽거나 만들지 못하면 던진다 */
export function draftSealFor(file: string, env: Record<string, string | undefined> = process.env): DraftSeal {
  return { key: draftSealKey(env), context: file };
}
