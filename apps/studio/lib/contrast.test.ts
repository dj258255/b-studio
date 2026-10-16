/**
 * globals.css의 색 토큰을 그대로 읽어 작은 글씨 대비(WCAG 1.4.3, 4.5:1)를 잰다.
 * 바탕은 화면에 실제로 깔리는 것들: 맨 바탕(ground), 왼쪽 위에 번진 청록 빛이 가장 짙은 자리, 불투명 패널,
 * 그리고 그 둘 위에 얹힌 유리 표면. 밝은·어두운 테마를 모두 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(import.meta.dirname, "../app/globals.css"), "utf8");

type Rgb = [number, number, number];
interface Rgba {
  rgb: Rgb;
  alpha: number;
}

/** 블록 안의 `--이름: 값;` 선언만 모은다 */
function readTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens.set(match[1]!, match[2]!.trim());
  return tokens;
}

/** 여는 중괄호부터 짝이 맞는 닫는 중괄호까지 */
function blockAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${marker}를 찾지 못했습니다`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`${marker} 블록이 닫히지 않았습니다`);
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return { rgb: [0, 2, 4].map((offset) => parseInt(hex[1]!.slice(offset, offset + 2), 16)) as Rgb, alpha: 1 };
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgb) return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  throw new Error(`읽을 수 없는 색: ${value}`);
}

function over(top: Rgba, bottom: Rgb): Rgb {
  return top.rgb.map((channel, index) => channel * top.alpha + bottom[index]! * (1 - top.alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const light = readTokens(blockAfter(css, ":root {"));
const dark = new Map([...light, ...readTokens(blockAfter(blockAfter(css, "@media (prefers-color-scheme: dark)"), ":root"))]);

function backgrounds(tokens: Map<string, string>): Record<string, Rgb> {
  const color = (name: string) => parseColor(tokens.get(name) ?? "");
  const ground = color("ground").rgb;
  const bloom = over(color("bloom-teal"), ground);
  const panel = color("panel").rgb;
  return {
    ground,
    "청록 빛이 가장 짙은 바탕": bloom,
    panel,
    "바탕 위 유리": over(color("glass-fill"), ground),
    "청록 빛 위 유리": over(color("glass-fill"), bloom),
  };
}

const TEXT_TOKENS = ["ink", "muted", "pass", "fail", "wait"] as const;

describe.each([
  ["밝은 테마", light],
  ["어두운 테마", dark],
])("%s 글자 대비", (_, tokens) => {
  const surfaces = backgrounds(tokens);
  for (const token of TEXT_TOKENS) {
    for (const [surface, background] of Object.entries(surfaces)) {
      it(`${token}은 ${surface} 위에서 4.5:1 이상이다`, () => {
        const ratio = contrast(parseColor(tokens.get(token) ?? "").rgb, background);
        expect(ratio, `${token} ${tokens.get(token)} / ${surface}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("대비 계산", () => {
  it("흰 바탕의 검은 글자는 21:1, 같은 색은 1:1이다", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([85, 112, 107], [85, 112, 107])).toBe(1);
  });
});

describe("메뉴·누르는 자리 유틸리티", () => {
  it("메뉴 표면은 불투명한 패널 색을 쓰고 뒤를 흐리지 않는다", () => {
    const surface = blockAfter(css, "@utility menu-surface");
    expect(surface).toMatch(/background-color:\s*var\(--panel\)/);
    expect(surface).not.toContain("backdrop-filter");
    expect(surface).not.toContain("--glass-fill");
  });

  it("누르는 자리는 어디서나 24px 이상, 손가락으로 누르는 좁은 화면에서는 44px 이상이다", () => {
    const target = blockAfter(css, "@utility tap-target");
    expect(target).toMatch(/^\s*min-height:\s*1\.5rem;/m);
    expect(target).toMatch(/@media \(pointer: coarse\), \(width < 40rem\)\s*\{\s*min-height:\s*2\.75rem;/);
  });
});
