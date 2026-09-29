/**
 * 화면 확인(QA)과 원격 브라우저가 보내는 실시간 프레임 채널.
 * 프레임은 세션 기록에 남기지 않고 메모리에만 둔다(프레임 한 장이 수십 KB라 기록이 금방 커진다).
 * 새로 연결한 구독자에게는 마지막 한 장만 곧바로 보내 화면이 빈 채로 뜨지 않게 한다.
 * 원격 브라우저가 막은 요청 수 같은 한 줄짜리 상태도 같은 채널로 보낸다(이것도 기록에 쌓지 않는다).
 */

export type LiveFrameSource = 'qa' | 'remote';

export interface LiveFrame {
  /** qa: 플랫폼의 화면 확인, remote: 원격 브라우저 */
  source: LiveFrameSource;
  /** 화면 확인이면 무엇을 확인하는 중인지 */
  check?: string;
  mime: string;
  /** base64로 인코딩한 이미지 한 장 */
  data: string;
  width: number;
  height: number;
  /** 프레임을 받은 시각(ms) */
  at: number;
}

/** 원격 브라우저가 허용하지 않은 출처로 나가려던 요청을 막은 수 */
export interface LiveBlocked {
  kind: 'blocked';
  count: number;
}

export type LiveMessage = LiveFrame | LiveBlocked;

export type LiveListener = (message: LiveMessage) => void;

interface Channel {
  listeners: Set<LiveListener>;
  last?: LiveFrame;
  blocked?: number;
}

// 개발 서버의 HMR로 모듈이 다시 로드돼도 구독을 잃지 않도록 전역에 둔다
const globalStore = globalThis as typeof globalThis & { __bStudioLiveFrames?: Map<string, Channel> };
const channels = (globalStore.__bStudioLiveFrames ??= new Map());

function channelFor(sessionId: string): Channel {
  let channel = channels.get(sessionId);
  if (!channel) {
    channel = { listeners: new Set() };
    channels.set(sessionId, channel);
  }
  return channel;
}

/** 구독하고, 마지막 프레임과 차단 수가 있으면 곧바로 보낸다. 돌려준 함수로 구독을 푼다 */
export function subscribe(sessionId: string, listener: LiveListener): () => void {
  const channel = channelFor(sessionId);
  channel.listeners.add(listener);
  if (channel.last) listener(channel.last);
  if (channel.blocked !== undefined) listener({ kind: 'blocked', count: channel.blocked });
  return () => {
    channel.listeners.delete(listener);
    if (channel.listeners.size === 0) channels.delete(sessionId);
  };
}

function emit(channel: Channel, message: LiveMessage): void {
  for (const listener of channel.listeners) {
    try {
      listener(message);
    } catch {
      // 구독자 하나의 오류가 다른 구독자에게 번지지 않게 한다
    }
  }
}

export function publish(sessionId: string, frame: LiveFrame): void {
  const channel = channelFor(sessionId);
  channel.last = frame;
  emit(channel, frame);
}

export function publishBlocked(sessionId: string, count: number): void {
  const channel = channelFor(sessionId);
  channel.blocked = count;
  emit(channel, { kind: 'blocked', count });
}

/** 세션이 멈출 때 마지막 상태를 지운다. 열려 있던 스트림의 구독은 스스로 풀린다 */
export function clearFrames(sessionId: string): void {
  channels.delete(sessionId);
}
