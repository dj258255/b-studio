import { beforeEach, describe, expect, it, vi } from 'vitest';

const { launch, startOriginProxy } = vi.hoisted(() => ({ launch: vi.fn(), startOriginProxy: vi.fn() }));
vi.mock('playwright-core', () => ({ chromium: { launch } }));
vi.mock('./origin-proxy', () => ({ startOriginProxy }));

import { BrowserUnavailableError, launchBrowser, runInBrowser } from './browser-check';

// 허용 출처가 주어졌는데 출처 제한 프록시를 세우지 못하면 프록시 없이 브라우저를 띄우지 않는다(#1210).
// 띄웠다면 리다이렉트·서비스 워커를 막지 못한 채 검사가 통과로 보인다
describe('출처 제한 프록시를 세우지 못할 때', () => {
  beforeEach(() => {
    launch.mockReset();
    launch.mockRejectedValue(new Error('launch가 불리면 안 되는 시험에서 불렸다'));
    startOriginProxy.mockReset();
  });

  it('브라우저를 띄우지 않고 "브라우저를 쓸 수 없음"으로 알린다', async () => {
    startOriginProxy.mockRejectedValue(new Error('listen EADDRNOTAVAIL'));
    const error = await runInBrowser('http://127.0.0.1:1/', { allowedOrigins: ['http://127.0.0.1:1'] }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserUnavailableError);
    expect((error as Error).message).toContain('listen EADDRNOTAVAIL');
    expect(launch).not.toHaveBeenCalled();
  });

  it('프록시는 섰지만 브라우저가 안 떠도 프록시를 닫는다', async () => {
    const close = vi.fn(async () => {});
    startOriginProxy.mockResolvedValue({ server: 'http://127.0.0.1:9', close });
    await expect(runInBrowser('http://127.0.0.1:1/', { allowedOrigins: ['http://127.0.0.1:1'] })).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(launch).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('허용 출처가 없는 호출은 프록시 없이 지금처럼 띄운다', async () => {
    await expect(runInBrowser('http://127.0.0.1:1/', {})).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(startOriginProxy).not.toHaveBeenCalled();
    expect(launch.mock.calls[0]![0]).toEqual({ headless: true });
  });

  it('프록시 주소를 받으면 loopback도 프록시로 보내고 WebRTC UDP를 막는 인자로 띄운다', async () => {
    launch.mockResolvedValue({});
    await launchBrowser({ proxyServer: 'http://127.0.0.1:4321' });
    expect(launch.mock.calls[0]![0]).toEqual({
      headless: true,
      proxy: { server: 'http://127.0.0.1:4321' },
      args: ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
  });
});
