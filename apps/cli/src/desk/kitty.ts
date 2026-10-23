/**
 * Kitty 그래픽 프로토콜로 카드 그림을 선명하게 그린다(#902). Ghostty·kitty가 받는다.
 *
 * 그림은 Unicode placeholder 방식으로 놓는다: 그림을 가상 배치(U=1, 칸 수 c·줄 수 r)로 한 번 보내 두고, 화면에는 그 자리에
 * placeholder 글자(U+10EEEE)와 줄·열 번호를 뜻하는 결합 문자를 쓴다. 이미지 id는 그 글자의 24비트 글자색이다.
 * 그래서 그림 자리도 desk의 다른 글처럼 줄 단위로 비교하고 다시 쓸 수 있고, 지우면 그림도 사라진다.
 * 움짤은 프레임마다 다른 이미지로 한 번씩 보내 두고, 다시 그릴 때 글자색(이미지 id)만 바꾼다.
 * tmux·screen 안에서는 쓰지 않는다(넘겨주는 설정이 따로 필요하다). 그때와 그 밖의 터미널은 반칸 블록으로 그린다
 */
import { encodePng, framesOf, scalePixels, trimSprite, type Sprite } from './sprite';

export type GraphicsSetting = 'auto' | 'kitty' | 'blocks';
export type GraphicsMode = 'kitty' | 'blocks';

/** 그림 자리 글자 */
export const PLACEHOLDER = '\u{10EEEE}';
/**
 * 줄·열 번호를 뜻하는 결합 문자(kitty의 rowcolumn-diacritics 목록 앞부분). 모두 폭 0인 결합 문자(U+0300~U+036F)라
 * desk의 폭 계산과 맞는다. 그래서 그림 자리는 이 수(30칸·30줄)까지만 쓴다
 */
export const DIACRITICS = [
  0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351, 0x352, 0x357, 0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b,
  0x36c, 0x36d, 0x36e, 0x36f,
].map((code) => String.fromCodePoint(code));

/** 한 번에 보내는 base64 조각의 크기(프로토콜의 상한) */
const CHUNK = 4096;
/** 보낼 그림의 긴 변을 이만큼 되게 정수 배로 키운다(터미널이 칸에 맞춰 줄일 때 덜 흐리게) */
const UPLOAD_SIDE = 256;
const MAX_FACTOR = 8;
const APC = '\x1b_G';
const ST = '\x1b\\';

/** 이 터미널에서 Kitty 그래픽을 쓸지. 설정이 앞서고, auto면 Ghostty·kitty에서 쓰되 tmux·screen 안이면 쓰지 않는다 */
export function graphicsMode(env: NodeJS.ProcessEnv, setting: GraphicsSetting = 'auto'): GraphicsMode {
  if (setting !== 'auto') return setting;
  if (env.TMUX || env.STY) return 'blocks';
  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();
  if (program === 'ghostty' || term === 'xterm-ghostty' || term === 'xterm-kitty' || env.KITTY_WINDOW_ID) return 'kitty';
  return 'blocks';
}

/** 그림을 보내고 cols칸 × rows줄 가상 배치를 만드는 이스케이프(응답은 끈다, q=2). 큰 자료는 4096바이트씩 나눈다 */
export function transmitImage(id: number, png: Uint8Array, cols: number, rows: number): string {
  const data = Buffer.from(png).toString('base64');
  const parts: string[] = [];
  for (let at = 0; at < data.length; at += CHUNK) parts.push(data.slice(at, at + CHUNK));
  if (parts.length === 0) parts.push('');
  return parts
    .map((part, index) => {
      const more = index < parts.length - 1 ? 1 : 0;
      const keys = index === 0 ? `a=T,U=1,f=100,i=${id},c=${cols},r=${rows},q=2,m=${more}` : `m=${more},q=2`;
      return `${APC}${keys};${part}${ST}`;
    })
    .join('');
}

/** 이미지와 그 배치를 지우고 자료도 버린다 */
export function deleteImage(id: number): string {
  return `${APC}a=d,d=I,i=${id},q=2${ST}`;
}

/** 이미지 id를 글자색으로 단 placeholder 줄들. 줄마다 정확히 cols칸이다 */
export function placeholderLines(id: number, cols: number, rows: number): string[] {
  const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = color;
    for (let column = 0; column < cols; column++) line += PLACEHOLDER + DIACRITICS[row]! + DIACRITICS[column]!;
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}

/**
 * desk가 보낸 이미지들. art()는 그림의 한 프레임을 cols×rows 자리에 놓을 placeholder 줄을 돌려주고,
 * 아직 보내지 않은 프레임이면 보낼 이스케이프를 모아 둔다. 그리는 쪽은 그 줄을 쓰기 전에 drain()으로 받은 것을 먼저 쓴다.
 * 프레임은 처음 보일 때 보낸다(움짤 한 바퀴 동안 나눠 보낸다)
 */
export class KittyImages {
  readonly #ids = new WeakMap<Sprite, Map<string, number[]>>();
  readonly #sent = new Set<number>();
  #pending = '';
  #next: number;

  /** base는 첫 이미지 id. 다른 프로그램이 같은 터미널에 둔 이미지와 겹치지 않게 기본은 무작위 자리에서 시작한다 */
  constructor(base = 0x100000 + Math.floor(Math.random() * 0xd00000)) {
    this.#next = base;
  }

  art(source: Sprite, frame: number, cols: number, rows: number): string[] {
    const sprite = trimSprite(source);
    const size = { cols: Math.max(1, Math.min(DIACRITICS.length, cols)), rows: Math.max(1, Math.min(DIACRITICS.length, rows)) };
    const frames = framesOf(sprite);
    const index = Math.max(0, Math.min(frames.length - 1, frame));
    let bySize = this.#ids.get(sprite);
    if (!bySize) {
      bySize = new Map();
      this.#ids.set(sprite, bySize);
    }
    const key = `${size.cols}x${size.rows}`;
    let ids = bySize.get(key);
    if (!ids) {
      ids = frames.map(() => this.#allocate());
      bySize.set(key, ids);
    }
    const id = ids[index]!;
    if (!this.#sent.has(id)) {
      const factor = Math.max(1, Math.min(MAX_FACTOR, Math.floor(UPLOAD_SIDE / Math.max(sprite.width, sprite.height))));
      const pixels = scalePixels(frames[index]!.pixels, sprite.width, sprite.height, factor);
      this.#pending += transmitImage(id, encodePng(sprite.width * factor, sprite.height * factor, pixels), size.cols, size.rows);
      this.#sent.add(id);
    }
    return placeholderLines(id, size.cols, size.rows);
  }

  /** 아직 쓰지 않은 전송 이스케이프를 꺼낸다 */
  drain(): string {
    const out = this.#pending;
    this.#pending = '';
    return out;
  }

  /** 보낸 이미지를 모두 지우는 이스케이프(desk를 나갈 때) */
  clear(): string {
    let out = '';
    for (const id of this.#sent) out += deleteImage(id);
    this.#sent.clear();
    this.#pending = '';
    return out;
  }

  #allocate(): number {
    const id = this.#next;
    // 24비트 안에서 돈다. 0은 쓰지 않는다
    this.#next = this.#next >= 0xffffff ? 1 : this.#next + 1;
    return id;
  }
}
