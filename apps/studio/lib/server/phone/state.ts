import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fromBase64, KEY_BYTES, newKeyPair, randomHex, safeEqual, toBase64 } from './crypto';

/**
 * 휴대폰 짝짓기의 저장 상태: 서버의 장기 키, 기기 목록, 켜짐 스위치, 짝 코드(메모리).
 * 파일은 사용자 설정 폴더(`$XDG_CONFIG_HOME/b-studio/phone`, 없으면 `~/.config/b-studio/phone`)에 폴더 0700, 파일 0600으로 둔다.
 * 시험은 B_STUDIO_PHONE_DIR로 임시 폴더를 가리킨다. 프로세스가 사는 동안 메모리가 기준이고(globalThis, HMR에도 유지), 바뀔 때마다 파일에 쓴다
 */

export interface PhoneDevice {
  id: string;
  name: string;
  /** 기기의 장기 X25519 공개 키(base64) */
  publicKey: string;
  /** 기기 토큰의 SHA-256(16진수). 토큰 원문은 서버에 두지 않는다 */
  tokenHash: string;
  /** 짝을 맺을 때 desk를 쓰던 사용자. 이 기기의 요청은 이 사용자의 권한으로만 돈다 */
  user: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface PhoneSettings {
  enabled: boolean;
  port: number;
}

export const DEFAULT_PHONE_PORT = 38917;
export const MAX_DEVICES = 10;
export const MAX_DEVICE_NAME = 40;
export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_WRONG = 5;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;

interface PairingCode {
  code: string;
  user: string;
  expiresAt: number;
  wrong: number;
}

interface Store {
  dir?: string;
  secretKey?: Uint8Array;
  publicKey?: Uint8Array;
  devices?: Map<string, PhoneDevice>;
  settings?: PhoneSettings;
  pairing?: PairingCode;
}

const holder = globalThis as typeof globalThis & { __bStudioPhone?: Store };
function store(): Store {
  return (holder.__bStudioPhone ??= {});
}

/** 시험에서 폴더나 환경이 바뀌면 메모리를 비운다 */
export function resetPhoneState(): void {
  holder.__bStudioPhone = {};
}

export function phoneDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.B_STUDIO_PHONE_DIR?.trim();
  if (configured) return configured;
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), '.config');
  return path.join(base, 'b-studio', 'phone');
}

function ensureDir(env: Record<string, string | undefined>): string {
  const s = store();
  const dir = phoneDir(env);
  if (s.dir === dir) return dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  // 폴더 자리에 링크가 있으면 링크 너머에 비밀 키를 쓰게 되므로 쓰지 않는다
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`휴대폰 설정 폴더가 폴더가 아니거나 링크입니다: ${dir}`);
  chmodSync(dir, 0o700);
  s.dir = dir;
  return dir;
}

function writeSecretFile(file: string, content: string): void {
  const staged = `${file}.${randomHex(8)}.tmp`;
  writeFileSync(staged, content, { mode: 0o600, flag: 'wx' });
  renameSync(staged, file);
  chmodSync(file, 0o600);
}

/** 파일을 읽는다. 링크이거나 그룹·다른 사용자가 읽을 수 있으면 쓰지 않는다(없으면 undefined) */
function readSecretFile(file: string): string | undefined {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`휴대폰 설정 파일이 일반 파일이 아닙니다: ${file}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`휴대폰 설정 파일의 권한이 넓습니다(chmod 600 ${file} 뒤에 다시 시도하세요)`);
  return readFileSync(file, 'utf8');
}

/** 서버의 장기 키 쌍. 처음 부를 때 만든다. 파일이 깨졌으면 쓰지 않고 던진다(새로 만들면 짝 맺은 기기가 모두 끊긴다) */
export function serverKeys(env: Record<string, string | undefined> = process.env): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const s = store();
  if (s.publicKey && s.secretKey && s.dir === phoneDir(env)) return { publicKey: s.publicKey, secretKey: s.secretKey };
  const dir = ensureDir(env);
  const file = path.join(dir, 'server-key.json');
  const raw = readSecretFile(file);
  if (raw !== undefined) {
    const parsed = JSON.parse(raw) as { publicKey?: unknown; secretKey?: unknown };
    const publicKey = fromBase64(parsed.publicKey, KEY_BYTES);
    const secretKey = fromBase64(parsed.secretKey, KEY_BYTES);
    if (!publicKey || !secretKey) throw new Error(`서버 키 파일이 올바르지 않습니다: ${file}`);
    s.publicKey = publicKey;
    s.secretKey = secretKey;
  } else {
    const pair = newKeyPair();
    writeSecretFile(file, `${JSON.stringify({ publicKey: toBase64(pair.publicKey), secretKey: toBase64(pair.secretKey) })}\n`);
    s.publicKey = pair.publicKey;
    s.secretKey = pair.secretKey;
  }
  return { publicKey: s.publicKey, secretKey: s.secretKey };
}

function isDevice(value: unknown): value is PhoneDevice {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === 'string' && /^[0-9a-f]{32}$/.test(d.id) &&
    typeof d.name === 'string' &&
    fromBase64(d.publicKey, KEY_BYTES) !== undefined &&
    typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash) &&
    typeof d.user === 'string' && d.user.length > 0 &&
    typeof d.createdAt === 'number' &&
    typeof d.lastSeenAt === 'number'
  );
}

function devices(env: Record<string, string | undefined> = process.env): Map<string, PhoneDevice> {
  const s = store();
  if (s.devices && s.dir === phoneDir(env)) return s.devices;
  const dir = ensureDir(env);
  const file = path.join(dir, 'devices.json');
  const map = new Map<string, PhoneDevice>();
  let raw: string | undefined;
  try {
    raw = readSecretFile(file);
  } catch (error) {
    // 권한이 넓거나 링크인 목록은 믿지 않는다: 기기가 없는 것으로 두고(모두 다시 짝 맺어야 한다) 파일을 건드리지 않는다
    console.error('[b-studio] 휴대폰 기기 목록을 쓰지 않습니다:', error instanceof Error ? error.message : String(error));
    s.devices = map;
    s.dir = dir;
    return map;
  }
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { devices?: unknown };
      if (!Array.isArray(parsed.devices)) throw new Error('devices가 목록이 아닙니다');
      for (const entry of parsed.devices) if (isDevice(entry)) map.set(entry.id, entry);
    } catch (error) {
      renameSync(file, `${file}.bad-${Date.now()}`);
      console.error('[b-studio] 휴대폰 기기 목록이 깨져 옆으로 치웠습니다. 기기를 다시 짝 맺어야 합니다:', error instanceof Error ? error.message : String(error));
    }
  }
  s.devices = map;
  return map;
}

function saveDevices(env: Record<string, string | undefined>): void {
  const dir = ensureDir(env);
  writeSecretFile(path.join(dir, 'devices.json'), `${JSON.stringify({ devices: [...devices(env).values()] }, null, 2)}\n`);
}

export function listDevices(env: Record<string, string | undefined> = process.env): PhoneDevice[] {
  return [...devices(env).values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function getDevice(id: string, env: Record<string, string | undefined> = process.env): PhoneDevice | undefined {
  return devices(env).get(id);
}

export function cleanDeviceName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return [...cleaned].slice(0, MAX_DEVICE_NAME).join('') || '휴대폰';
}

export function addDevice(input: { name: string; publicKey: string; tokenHash: string; user: string }, now: number, env: Record<string, string | undefined> = process.env): PhoneDevice {
  const map = devices(env);
  if (map.size >= MAX_DEVICES) throw new Error(`짝 맺은 기기는 ${MAX_DEVICES}대까지입니다. 쓰지 않는 기기를 끊고 다시 하세요`);
  const device: PhoneDevice = { id: randomHex(16), name: cleanDeviceName(input.name), publicKey: input.publicKey, tokenHash: input.tokenHash, user: input.user, createdAt: now, lastSeenAt: now };
  map.set(device.id, device);
  saveDevices(env);
  return device;
}

export function removeDevice(id: string, env: Record<string, string | undefined> = process.env): boolean {
  const map = devices(env);
  const removed = map.delete(id);
  if (removed) saveDevices(env);
  return removed;
}

/** 마지막으로 본 시각. 요청마다 파일을 쓰지 않으려고 메모리만 고친다(다음 변경 때 함께 저장된다) */
export function touchDevice(id: string, now: number, env: Record<string, string | undefined> = process.env): void {
  const device = devices(env).get(id);
  if (device) device.lastSeenAt = now;
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65_535;
}

/** 켜짐 스위치. 파일이 없거나 읽지 못하면 꺼짐이다(기본 꺼짐, fail-closed) */
export function readSettings(env: Record<string, string | undefined> = process.env): PhoneSettings {
  const s = store();
  if (s.settings && s.dir === phoneDir(env)) return s.settings;
  let settings: PhoneSettings = { enabled: false, port: DEFAULT_PHONE_PORT };
  try {
    const dir = ensureDir(env);
    const file = path.join(dir, 'settings.json');
    const raw = existsSync(file) ? readSecretFile(file) : undefined;
    if (raw !== undefined) {
      const parsed = JSON.parse(raw) as { enabled?: unknown; port?: unknown };
      settings = { enabled: parsed.enabled === true, port: validPort(parsed.port) ? parsed.port : DEFAULT_PHONE_PORT };
    }
  } catch (error) {
    console.error('[b-studio] 휴대폰 설정을 읽지 못해 꺼짐으로 둡니다:', error instanceof Error ? error.message : String(error));
  }
  s.settings = settings;
  return settings;
}

export function writeSettings(patch: Partial<PhoneSettings>, env: Record<string, string | undefined> = process.env): PhoneSettings {
  const next = { ...readSettings(env), ...patch };
  const dir = ensureDir(env);
  writeSecretFile(path.join(dir, 'settings.json'), `${JSON.stringify(next)}\n`);
  store().settings = next;
  return next;
}

function newCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  // 32글자 알파벳이라 바이트의 아래 5비트를 그대로 써도 치우침이 없다
  return [...bytes].map((byte) => CODE_ALPHABET[byte & 31]).join('');
}

/** 새 짝 코드. 한 번에 하나만 있고, 새로 만들면 앞의 것은 못 쓴다 */
export function createPairingCode(user: string, now: number): { code: string; expiresAt: number } {
  const pairing: PairingCode = { code: newCode(), user, expiresAt: now + PAIRING_TTL_MS, wrong: 0 };
  store().pairing = pairing;
  return { code: pairing.code, expiresAt: pairing.expiresAt };
}

export function cancelPairing(): void {
  store().pairing = undefined;
}

export function pendingPairing(now: number): { expiresAt: number } | undefined {
  const pairing = store().pairing;
  if (!pairing) return undefined;
  if (pairing.expiresAt <= now) {
    store().pairing = undefined;
    return undefined;
  }
  return { expiresAt: pairing.expiresAt };
}

export type PairingCheck = { ok: true; user: string } | { ok: false; reason: 'none' | 'expired' | 'wrong' };

/**
 * 짝 코드 확인. 맞으면 그 자리에서 코드를 지운다(한 번만). 틀리면 횟수를 세고, 상한에 닿으면 코드를 지운다.
 * 만료·소진·없음은 같은 거절이다(호출한 쪽이 까닭을 손님에게 나눠 말하지 않는다)
 */
export function checkPairingCode(given: string, now: number): PairingCheck {
  const s = store();
  const pairing = s.pairing;
  if (!pairing) return { ok: false, reason: 'none' };
  if (pairing.expiresAt <= now) {
    s.pairing = undefined;
    return { ok: false, reason: 'expired' };
  }
  if (!safeEqual(given, pairing.code)) {
    pairing.wrong += 1;
    if (pairing.wrong >= PAIRING_MAX_WRONG) s.pairing = undefined;
    return { ok: false, reason: 'wrong' };
  }
  s.pairing = undefined;
  return { ok: true, user: pairing.user };
}
