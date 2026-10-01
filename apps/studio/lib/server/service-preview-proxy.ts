import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createPreviewProxy } from './preview-proxy';

/**
 * 세션의 서비스마다 하나씩 띄우는 로컬 미리보기 프록시(ADR-113). 처음 요청이 오면 127.0.0.1의 임의 포트에 열고,
 * 세션이 멈출 때까지 그대로 둔다. 세션이 재시작해 서비스 주소(포트)가 바뀌어도 프록시를 다시 만들지 않고
 * entry.target만 갱신한다 — remote-browsers.ts와 같은 "HMR에도 살아남는 전역 Map" 패턴을 쓴다
 */
interface ProxyEntry {
  server: Server;
  port: number;
  target: string;
}

const globalStore = globalThis as typeof globalThis & { __bStudioServiceProxies?: Map<string, ProxyEntry> };
const store = (globalStore.__bStudioServiceProxies ??= new Map());

function key(sessionId: string, service: string): string {
  return `${sessionId}:${service}`;
}

/** 이 세션·서비스의 로컬 프록시 주소를 돌려준다. 없으면 새로 띄우고, 있으면 가리키는 주소만 최신으로 갱신한다 */
export async function ensureServicePreviewProxy(sessionId: string, service: string, target: string): Promise<string> {
  const id = key(sessionId, service);
  const existing = store.get(id);
  if (existing) {
    existing.target = target;
    return `http://127.0.0.1:${existing.port}`;
  }

  const entry: ProxyEntry = { server: createPreviewProxy({ resolve: () => entry.target }), port: 0, target };
  await new Promise<void>((resolve, reject) => {
    entry.server.once('error', reject);
    entry.server.listen(0, '127.0.0.1', resolve);
  });
  entry.port = (entry.server.address() as AddressInfo).port;
  store.set(id, entry);
  return `http://127.0.0.1:${entry.port}`;
}

/** 세션을 멈출 때 그 세션의 모든 서비스 프록시를 닫는다. 열려 있지 않으면 아무것도 하지 않는다 */
export async function closeServicePreviewProxies(sessionId: string): Promise<void> {
  const prefix = `${sessionId}:`;
  const closing: Promise<void>[] = [];
  for (const [id, entry] of store) {
    if (!id.startsWith(prefix)) continue;
    store.delete(id);
    closing.push(new Promise((resolve) => entry.server.close(() => resolve())));
  }
  await Promise.all(closing);
}

/** 스튜디오 서버가 내려갈 때 남은 프록시를 모두 닫는다(registerCleanup과 같은 자리에서 쓴다) */
export async function closeAllServicePreviewProxies(): Promise<void> {
  const sessionIds = new Set([...store.keys()].map((id) => id.slice(0, id.indexOf(':'))));
  await Promise.all([...sessionIds].map((sessionId) => closeServicePreviewProxies(sessionId)));
}
