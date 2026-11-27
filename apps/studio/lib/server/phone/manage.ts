import { requireUser } from '../access';
import { authConfig, isLoopbackHost } from '../auth';
import { StudioError } from '../errors';
import { assertLocalToken } from '../terminal-access';
import { toBase64 } from './crypto';
import { phoneAllowed, phoneGateway, phoneListening } from './listener';
import { createPairingCode, listDevices, pendingPairing, readSettings, serverKeys } from './state';

/**
 * desk가 휴대폰 짝짓기를 다루는 라우트(`/api/phone`)의 공통 검사와 화면용 값.
 * 이 라우트들은 휴대폰 귀가 아니라 본 서버에 있고, 이 컴퓨터의 주소(127.0.0.1)로 온 요청만 받는다 — 암호 통로를 켜고 기기를 맺는 일이라
 * 인증을 켠 서버의 "다른 주소 허용" 예외(assertLocalRequest)를 쓰지 않는다. 그다음 로컬 토큰(개인 PC)과 로그인 사용자를 본다
 */
export function assertPhoneManager(headers: Headers): string {
  if (!isLoopbackHost(headers)) throw new StudioError(403, '휴대폰 연결은 이 컴퓨터의 주소(127.0.0.1 · localhost)로 연 desk에서만 다룹니다');
  assertLocalToken(headers);
  return requireUser(headers);
}

/** 인증을 켠 서버에서 짝짓기 스위치는 관리자만 바꾼다. 개인 PC는 누구나(=본인) */
export function canTogglePhone(user: string): boolean {
  const config = authConfig();
  return config.mode === 'none' || config.admins.has(user);
}

function isAdmin(user: string): boolean {
  const config = authConfig();
  return config.mode === 'none' || config.admins.has(user);
}

export interface PhoneView {
  /** 이 서버가 짝짓기를 허용하는가(인증을 켠 서버는 운영자가 B_STUDIO_PHONE=1을 적어야 한다) */
  allowed: boolean;
  enabled: boolean;
  /** 귀가 열린 주소들(host:port). 꺼져 있으면 빈 목록 */
  addresses: string[];
  pairing?: { expiresAt: number };
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number; connected: boolean; user: string }>;
}

export function phoneView(user: string): PhoneView {
  const settings = readSettings();
  const listening = phoneListening();
  const connected = phoneGateway()?.connectedDevices() ?? new Set<string>();
  const pairing = pendingPairing(user, Date.now());
  return {
    allowed: phoneAllowed(),
    enabled: settings.enabled && listening !== undefined,
    addresses: listening ? listening.hosts.map((host) => `${host}:${listening.port}`) : [],
    ...(pairing ? { pairing } : {}),
    devices: listDevices()
      .filter((device) => device.user === user || isAdmin(user))
      .map((device) => ({ id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, connected: connected.has(device.id), user: device.user })),
  };
}

/** QR에 담을 내용. 서버 공개 키·일회용 코드·주소. 코드는 이 사용자의 것이고 한 번만 쓴다 */
export function newPairingPayload(user: string, hostname: string): { payload: string; expiresAt: number } {
  const listening = phoneListening();
  if (!listening || !readSettings().enabled) throw new StudioError(409, '휴대폰 연결이 꺼져 있습니다. 먼저 켜세요');
  let created: { code: string; expiresAt: number };
  try {
    created = createPairingCode(user, Date.now());
  } catch (error) {
    throw new StudioError(429, error instanceof Error ? error.message : String(error));
  }
  const { code, expiresAt } = created;
  const payload = JSON.stringify({ t: 'b-studio-pair', v: 1, k: toBase64(serverKeys().publicKey), c: code, a: listening.hosts.map((host) => `${host}:${listening.port}`), n: hostname.slice(0, 40) });
  return { payload, expiresAt };
}
