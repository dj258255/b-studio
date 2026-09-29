/**
 * Figma REST API 클라이언트. 개인 액세스 토큰은 서버 환경 변수(FIGMA_TOKEN)에서만 읽는다.
 * 원격 MCP(OAuth)를 쓰지 않는 이유는 ADR에 적었다. 토큰 값은 오류 메시지·로그·화면·모델 어디에도 넣지 않는다.
 */
export const FIGMA_API_BASE = 'https://api.figma.com';
/** 모델에게 넘기는 요약 텍스트 상한 */
const SUMMARY_MAX_CHARS = 8 * 1024;
const SUMMARY_MAX_DEPTH = 3;
const SUMMARY_MAX_NODES = 200;
const TEXT_MAX = 200;
const RETRY_MAX_WAIT_MS = 10_000;

export class FigmaError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FigmaError';
    this.status = status;
  }
}

/** Figma 노드는 종류마다 모양이 달라 필요한 필드만 느슨하게 읽는다 */
export interface FigmaPaint {
  type?: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a?: number };
}

export interface FigmaNode {
  id?: string;
  name?: string;
  type?: string;
  characters?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  absoluteBoundingBox?: { width?: number; height?: number };
  fills?: FigmaPaint[];
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number };
  children?: FigmaNode[];
}

export interface FigmaFrame {
  id: string;
  name: string;
  page: string;
  width: number;
  height: number;
}

export type FigmaFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<Response>;

export interface FigmaClientOptions {
  token?: string;
  fetch?: FigmaFetch;
  /** 테스트용. 기본은 https://api.figma.com */
  baseUrl?: string;
  /** 429를 만났을 때 기다리는 함수. 테스트는 기다리지 않는 함수를 넘긴다 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Figma가 준 이미지 URL만 내려받는다. 그 밖의 호스트로 서버가 요청을 보내지 않게 한다(SSRF 방지).
 * Figma 이미지는 figma.com이나 figma-…s3….amazonaws.com에서 온다
 */
export function isFigmaImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'figma.com' || host.endsWith('.figma.com') || (host.endsWith('.amazonaws.com') && host.includes('figma'));
}

/** 채우기에서 첫 단색을 hex로. 없으면 undefined */
function firstSolidColor(fills: FigmaPaint[] | undefined): string | undefined {
  const fill = fills?.find((paint) => paint.type === 'SOLID' && paint.visible !== false && paint.color);
  if (!fill?.color) return undefined;
  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
  return `#${channel(fill.color.r)}${channel(fill.color.g)}${channel(fill.color.b)}`;
}

function cornerRadius(node: FigmaNode): number | undefined {
  if (node.cornerRadius !== undefined) return node.cornerRadius;
  if (node.rectangleCornerRadii?.length) return Math.max(...node.rectangleCornerRadii);
  return undefined;
}

/** 노드 한 줄 요약: 이름·크기·자동 레이아웃·패딩·채우기 색·모서리·텍스트 스타일 */
function describeNode(node: FigmaNode): string {
  const parts: string[] = [`${node.type ? `${node.type} ` : ''}${node.name ?? '(이름 없음)'}`];
  const box = node.absoluteBoundingBox;
  if (box?.width !== undefined && box?.height !== undefined) parts.push(`${Math.round(box.width)}×${Math.round(box.height)}`);
  if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
    parts.push(`자동 레이아웃 ${node.layoutMode === 'HORIZONTAL' ? '가로' : '세로'}${node.itemSpacing !== undefined ? `, 간격 ${node.itemSpacing}` : ''}`);
  }
  const padding = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
  if (padding.some((value) => value !== undefined && value !== 0)) parts.push(`패딩 [${padding.map((value) => value ?? 0).join(' ')}]`);
  const fill = firstSolidColor(node.fills);
  if (fill) parts.push(`채우기 ${fill}`);
  const radius = cornerRadius(node);
  if (radius !== undefined) parts.push(`모서리 ${radius}`);
  if (typeof node.characters === 'string') {
    const text = node.characters.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
    const style = node.style;
    const font = [style?.fontFamily, style?.fontSize !== undefined ? `${style.fontSize}px` : undefined, style?.fontWeight, style?.lineHeightPx !== undefined ? `줄높이 ${Math.round(style.lineHeightPx)}` : undefined]
      .filter((value) => value !== undefined && value !== '')
      .join(' ');
    parts.push(`텍스트 "${text}"${font ? ` (${font})` : ''}`);
  }
  return parts.join(' · ');
}

/**
 * 노드를 텍스트로 요약한다. 자식은 깊이 3·노드 200개까지 내려가고, 결과는 8KB로 자른다(모델에 넘길 크기 제한).
 * 이미지는 넘기지 않으므로, 모델은 이 텍스트로 구조·스타일을 판단한다
 */
export function summarizeNode(root: FigmaNode): string {
  const lines: string[] = [];
  let count = 0;
  const walk = (node: FigmaNode, depth: number): void => {
    if (count >= SUMMARY_MAX_NODES || depth > SUMMARY_MAX_DEPTH) return;
    count += 1;
    lines.push(`${'  '.repeat(depth)}${describeNode(node)}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 0);
  if (count >= SUMMARY_MAX_NODES) lines.push(`[... 노드 ${SUMMARY_MAX_NODES}개까지만 요약했습니다 ...]`);
  const text = lines.join('\n');
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}\n[... ${text.length - SUMMARY_MAX_CHARS}자 잘림 ...]` : text;
}

/** `depth=2`로 받은 파일 응답에서 최상위 프레임만 추린다 */
const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION']);

interface FigmaFileResponse {
  version?: string;
  document?: { children?: Array<{ id?: string; name?: string; children?: FigmaNode[] }> };
}

export class FigmaClient {
  readonly #token: string | undefined;
  readonly #fetch: FigmaFetch;
  readonly #base: string;
  readonly #sleep: (ms: number) => Promise<void>;
  /** 파일 키 → 파일 목록(version 기준 캐시) */
  readonly #files = new Map<string, { version: string; frames: FigmaFrame[] }>();
  /** `key@version:ids` → 노드 요약 원본 캐시 */
  readonly #nodes = new Map<string, Record<string, FigmaNode>>();

  constructor(options: FigmaClientOptions = {}) {
    this.#token = options.token?.trim() || undefined;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#base = (options.baseUrl ?? FIGMA_API_BASE).replace(/\/$/, '');
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async getFile(key: string, signal?: AbortSignal): Promise<{ version: string; frames: FigmaFrame[] }> {
    const cached = this.#files.get(key);
    if (cached) return cached;

    const data = (await this.#fetchJson(`/v1/files/${encodeURIComponent(key)}?depth=2`, signal)) as FigmaFileResponse;
    const frames: FigmaFrame[] = [];
    for (const page of data.document?.children ?? []) {
      for (const node of page.children ?? []) {
        if (!node.type || !FRAME_TYPES.has(node.type)) continue;
        frames.push({
          id: node.id ?? '',
          name: node.name ?? '(이름 없음)',
          page: page.name ?? '',
          width: Math.round(node.absoluteBoundingBox?.width ?? 0),
          height: Math.round(node.absoluteBoundingBox?.height ?? 0),
        });
      }
    }
    const result = { version: data.version ?? '', frames };
    this.#files.set(key, result);
    return result;
  }

  /** 페이지별 프레임 목록 */
  async listFrames(key: string, signal?: AbortSignal): Promise<FigmaFrame[]> {
    return (await this.getFile(key, signal)).frames;
  }

  /** 프레임 id의 노드 원본(요약 전) */
  async getNodes(key: string, ids: readonly string[], signal?: AbortSignal): Promise<Record<string, FigmaNode>> {
    const { version } = await this.getFile(key, signal);
    const cacheKey = `${key}@${version}:${[...ids].sort().join(',')}`;
    const cached = this.#nodes.get(cacheKey);
    if (cached) return cached;

    const data = (await this.#fetchJson(`/v1/files/${encodeURIComponent(key)}/nodes?ids=${ids.map(encodeURIComponent).join(',')}`, signal)) as {
      nodes?: Record<string, { document?: FigmaNode }>;
    };
    const nodes: Record<string, FigmaNode> = {};
    for (const [id, entry] of Object.entries(data.nodes ?? {})) if (entry.document) nodes[id] = entry.document;
    this.#nodes.set(cacheKey, nodes);
    return nodes;
  }

  /** 프레임 하나의 요약 텍스트와 PNG */
  async summarizeFrame(key: string, id: string, signal?: AbortSignal): Promise<{ summary: string; png: Buffer }> {
    const nodes = await this.getNodes(key, [id], signal);
    const node = nodes[id];
    if (!node) throw new FigmaError('디자인 프레임을 찾을 수 없습니다', 404);
    const images = await this.exportImages(key, [id], { scale: 1 }, signal);
    const png = images.get(id);
    if (!png) throw new FigmaError('프레임 이미지를 내보내지 못했습니다', 502);
    return { summary: summarizeNode(node), png };
  }

  /** 프레임 PNG들을 내보내 내려받는다. 다운로드 URL은 Figma 이미지 호스트만 허용한다 */
  async exportImages(key: string, ids: readonly string[], { scale = 1, format = 'png' }: { scale?: number; format?: string } = {}, signal?: AbortSignal): Promise<Map<string, Buffer>> {
    const query = `ids=${ids.map(encodeURIComponent).join(',')}&format=${format}&scale=${scale}`;
    const data = (await this.#fetchJson(`/v1/images/${encodeURIComponent(key)}?${query}`, signal)) as { images?: Record<string, string | null>; err?: string | null };
    if (data.err) throw new FigmaError(`Figma가 이미지를 내보내지 못했습니다: ${data.err}`, 502);

    const result = new Map<string, Buffer>();
    for (const [id, url] of Object.entries(data.images ?? {})) {
      if (!url) throw new FigmaError(`프레임 ${id}의 이미지를 내보내지 못했습니다`, 502);
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !isFigmaImageHost(parsed.hostname)) throw new FigmaError('허용하지 않은 이미지 호스트입니다', 502);
      // 호스트 검사를 리다이렉트로 우회하지 못하게 따라가지 않는다(3xx는 실패)
      const response = await this.#fetch(url, { signal, redirect: 'manual' });
      if (!response.ok) throw new FigmaError(`이미지를 내려받지 못했습니다 (HTTP ${response.status})`, 502);
      result.set(id, Buffer.from(await response.arrayBuffer()));
    }
    return result;
  }

  /** 한 번의 429는 Retry-After를 존중해 한 번만 다시 시도한다 */
  async #fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.#token) throw new FigmaError('FIGMA_TOKEN이 설정되지 않았습니다. 서버 환경 변수에 Figma 개인 액세스 토큰을 넣으세요', 400);
    const url = `${this.#base}${path}`;
    const headers = { 'X-Figma-Token': this.#token };
    let response = await this.#fetch(url, { headers, signal });
    if (response.status === 429) {
      await this.#sleep(retryDelayMs(response));
      response = await this.#fetch(url, { headers, signal });
    }
    if (response.status === 429) throw new FigmaError('Figma API 요청 한도(429)에 걸렸습니다. 잠시 뒤 다시 시도하세요', 429);
    if (response.status === 401 || response.status === 403) throw new FigmaError('Figma 토큰이 올바르지 않거나 이 파일을 읽을 권한이 없습니다', 403);
    if (response.status === 404) throw new FigmaError('Figma 파일을 찾을 수 없습니다', 404);
    if (!response.ok) throw new FigmaError(`Figma API가 오류를 돌려줬습니다 (HTTP ${response.status})`, 502);
    return response.json();
  }
}

/** Retry-After(초)를 존중하되 상한을 둔다 */
function retryDelayMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_MAX_WAIT_MS) : 1_000;
}
