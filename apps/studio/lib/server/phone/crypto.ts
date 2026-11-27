import { createHash, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';

/**
 * 휴대폰 암호 통로의 암호 부품(docs/phone-protocol.md). 상자(box)는 X25519 + XSalsa20-Poly1305(tweetnacl)다.
 * 이 파일은 바이트와 글자를 바꾸는 일만 한다 — 누구를 믿을지는 gateway.ts가 정한다
 */

export const PHONE_PROTOCOL_VERSION = 1;
export const KEY_BYTES = nacl.box.publicKeyLength;
export const NONCE_BYTES = nacl.box.nonceLength;

/** nonce의 첫 바이트. 같은 열쇠로 방향·용도가 다른 메시지가 같은 nonce를 쓰지 않게 한다 */
export const NonceKind = { request: 1, response: 2 } as const;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** 표준 base64(패딩 포함)만 받는다. Buffer.from은 틀린 글자를 조용히 건너뛰므로, 모양을 먼저 확인하고 다시 인코딩해 같은지 본다 */
export function fromBase64(value: unknown, expectedBytes?: number, maxBytes = 1_048_576): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > Math.ceil(maxBytes / 3) * 4 || !BASE64.test(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (toBase64(bytes) !== value) return undefined;
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) return undefined;
  return bytes;
}

/** 메시지 nonce: [종류 1바이트][0 7바이트][요청 번호 8바이트 빅엔디언][0 8바이트]. 번호는 안전한 정수여야 한다 */
export function messageNonce(kind: number, seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError('번호가 올바르지 않습니다');
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce[0] = kind;
  new DataView(nonce.buffer).setBigUint64(8, BigInt(seq), false);
  return nonce;
}

export function newKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return nacl.box.keyPair();
}

export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length);
}

export function randomHex(bytes: number): string {
  return Buffer.from(nacl.randomBytes(bytes)).toString('hex');
}

/** 상대의 공개 키로 열고 내 비밀 키로 서명하는 상자 열기. 열리지 않으면 undefined */
export function openBox(cipher: Uint8Array, nonce: Uint8Array, theirPublic: Uint8Array, mySecret: Uint8Array): Uint8Array | undefined {
  return nacl.box.open(cipher, nonce, theirPublic, mySecret) ?? undefined;
}

export function sealBox(message: Uint8Array, nonce: Uint8Array, theirPublic: Uint8Array, mySecret: Uint8Array): Uint8Array {
  return nacl.box(message, nonce, theirPublic, mySecret);
}

/** 세션 열쇠: 내 임시 비밀 키와 상대 임시 공개 키에서 나온 공유 열쇠 */
export function sessionKey(theirEphemeralPublic: Uint8Array, myEphemeralSecret: Uint8Array): Uint8Array {
  return nacl.box.before(theirEphemeralPublic, myEphemeralSecret);
}

export function sealSecret(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  return nacl.secretbox(message, nonce, key);
}

export function openSecret(cipher: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | undefined {
  return nacl.secretbox.open(cipher, nonce, key) ?? undefined;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 시간이 일정한 문자열 비교. 길이가 달라도 같은 길이로 해시해서 비교한다 */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
