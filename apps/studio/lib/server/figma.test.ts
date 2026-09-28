import { describe, expect, it, vi } from 'vitest';
import { FigmaClient, FigmaError, isFigmaImageHost, summarizeNode } from './figma';

const FILE = {
  version: 'v1',
  document: {
    children: [
      {
        id: '0:1',
        name: 'Page 1',
        children: [
          { id: '1:2', name: 'Orders', type: 'FRAME', absoluteBoundingBox: { width: 375.4, height: 812.2 } },
          { id: '1:3', name: 'Group', type: 'GROUP', absoluteBoundingBox: { width: 10, height: 10 } },
        ],
      },
    ],
  },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('FigmaClient', () => {
  it('페이지·프레임 목록을 읽고, 프레임이 아닌 노드는 뺀다. 두 번째 호출은 캐시를 쓴다', async () => {
    const calls: string[] = [];
    const client = new FigmaClient({ token: 't', baseUrl: 'https://api.test', fetch: async (url) => (calls.push(url), json(FILE)) });

    expect(await client.listFrames('KEY')).toEqual([{ id: '1:2', name: 'Orders', page: 'Page 1', width: 375, height: 812 }]);
    await client.listFrames('KEY');
    expect(calls).toEqual(['https://api.test/v1/files/KEY?depth=2']);
  });

  it('429는 Retry-After를 존중해 한 번만 다시 시도한다', async () => {
    const sleep = vi.fn(async () => {});
    let count = 0;
    const client = new FigmaClient({
      token: 't',
      baseUrl: 'https://api.test',
      sleep,
      fetch: async () => {
        count += 1;
        return count === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : json(FILE);
      },
    });
    expect(await client.listFrames('KEY')).toHaveLength(1);
    expect(count).toBe(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('429가 계속되면 요청 한도 오류를 던진다', async () => {
    const client = new FigmaClient({ token: 't', baseUrl: 'https://api.test', sleep: async () => {}, fetch: async () => json({}, 429) });
    await expect(client.listFrames('KEY')).rejects.toMatchObject({ status: 429 });
  });

  it('토큰이 없으면 FIGMA_TOKEN 안내로 실패하고, 오류 문구에 토큰 값을 넣지 않는다', async () => {
    const missing = new FigmaClient({ token: '', baseUrl: 'https://api.test', fetch: async () => json(FILE) });
    await expect(missing.listFrames('KEY')).rejects.toThrow(/FIGMA_TOKEN/);

    const client = new FigmaClient({ token: 'super-secret-token', baseUrl: 'https://api.test', fetch: async () => json({}, 403) });
    const error = (await client.listFrames('KEY').catch((thrown: unknown) => thrown)) as FigmaError;
    expect(error).toBeInstanceOf(FigmaError);
    expect(error.status).toBe(403);
    expect(error.message).not.toContain('super-secret-token');
  });

  it('파일이 없으면(404) 그 이유를 알린다', async () => {
    const client = new FigmaClient({ token: 't', baseUrl: 'https://api.test', fetch: async () => json({}, 404) });
    await expect(client.listFrames('KEY')).rejects.toThrow(/파일을 찾을 수 없습니다/);
  });

  it('내보낸 이미지를 내려받고, Figma 이미지 호스트가 아니면 거부한다', async () => {
    const png = Buffer.from([1, 2, 3]);
    const client = new FigmaClient({
      token: 't',
      baseUrl: 'https://api.test',
      fetch: async (url) => {
        if (url.startsWith('https://api.test/v1/images/')) return json({ images: { '1:2': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc' } });
        if (url.startsWith('https://figma-alpha-api')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        throw new Error(`예상하지 않은 요청: ${url}`);
      },
    });
    expect(await client.exportImages('KEY', ['1:2'], { scale: 2 })).toEqual(new Map([['1:2', png]]));

    const evil = new FigmaClient({ token: 't', baseUrl: 'https://api.test', fetch: async () => json({ images: { '1:2': 'https://evil.example/x.png' } }) });
    await expect(evil.exportImages('KEY', ['1:2'])).rejects.toThrow(/허용하지 않은 이미지 호스트/);
  });

  it('이미지 호스트가 다른 곳으로 넘기면(3xx) 따라가지 않고 실패한다', async () => {
    const seen: Array<RequestRedirect | undefined> = [];
    const client = new FigmaClient({
      token: 't',
      baseUrl: 'https://api.test',
      fetch: async (url, init) => {
        if (url.startsWith('https://api.test/v1/images/')) return json({ images: { '1:2': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc' } });
        seen.push(init?.redirect);
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      },
    });
    await expect(client.exportImages('KEY', ['1:2'])).rejects.toThrow(/HTTP 302/);
    expect(seen).toEqual(['manual']);
  });

  it('Figma 이미지 호스트만 허용한다', () => {
    expect(isFigmaImageHost('figma.com')).toBe(true);
    expect(isFigmaImageHost('figma-alpha-api.s3.us-west-2.amazonaws.com')).toBe(true);
    expect(isFigmaImageHost('evil.example')).toBe(false);
    expect(isFigmaImageHost('s3.amazonaws.com')).toBe(false);
  });
});

describe('summarizeNode', () => {
  it('이름·크기·자동 레이아웃·패딩·색·모서리·텍스트를 한 줄씩 요약한다', () => {
    const summary = summarizeNode({
      id: 'root',
      name: 'Order card',
      type: 'FRAME',
      layoutMode: 'VERTICAL',
      itemSpacing: 8,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      cornerRadius: 12,
      absoluteBoundingBox: { width: 375, height: 200 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      children: [
        {
          id: 't',
          name: '제목',
          type: 'TEXT',
          characters: '주문 목록',
          style: { fontFamily: 'Pretendard', fontSize: 18, fontWeight: 700, lineHeightPx: 24 },
          fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        },
      ],
    });
    expect(summary).toContain('Order card');
    expect(summary).toContain('375×200');
    expect(summary).toContain('자동 레이아웃 세로, 간격 8');
    expect(summary).toContain('패딩 [16 16 16 16]');
    expect(summary).toContain('채우기 #ffffff');
    expect(summary).toContain('모서리 12');
    expect(summary).toContain('텍스트 "주문 목록"');
    expect(summary).toContain('Pretendard');
    expect(summary).toContain('#000000');
  });

  it('깊이 3까지만 내려가고, 노드 200개·8KB로 자른다', () => {
    const deep = { name: 'd0', type: 'FRAME', children: [{ name: 'd1', children: [{ name: 'd2', children: [{ name: 'd3', children: [{ name: 'd4' }] }] }] }] };
    expect(summarizeNode(deep)).not.toContain('d4');

    const wide = { name: 'root', type: 'FRAME', children: Array.from({ length: 300 }, (_, index) => ({ name: `child-${index}`, type: 'TEXT', characters: 'x'.repeat(200) })) };
    const summary = summarizeNode(wide);
    expect(summary.length).toBeLessThanOrEqual(8 * 1024 + 60);
    expect(summary).toContain('잘림');
    expect(summary).not.toContain('child-299');
  });
});
