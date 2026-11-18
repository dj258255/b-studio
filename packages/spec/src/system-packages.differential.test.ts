import { describe, expect, it } from 'vitest';
import * as legacy from './system-packages-legacy';
import * as current from './system-packages';

/**
 * `systemPackages` 변환은 Rust(`crates/bstudio-guard/src/system_packages.rs`)로 옮겼다.
 * 결과 글자와 오류 글자가 옛 TS(`system-packages-legacy.ts`)와 바이트까지 같은지 견준다.
 */

function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function outcome(run: () => string): { ok: true; value: string } | { ok: false; message: string } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const MARK_BEGIN = '# b-studio: systemPackages(studio.yaml)가 설치를 선언한 패키지';
const MARK_END = '# b-studio: systemPackages 끝';

const IMAGES = [
  'node:22-bookworm-slim',
  'node:22-alpine',
  'eclipse-temurin:21-jdk',
  'eclipse-temurin:21-jdk-alpine',
  'python:3.12-slim',
  'gradle:jdk21',
  'maven:3-eclipse-temurin-21',
  'debian:12',
  'ubuntu:24.04',
  'rust:1-slim',
  'scratch',
  '  node:22-alpine  ',
  'NODE:22-ALPINE',
  'alpine',
  'node',
  'nodejs:22',
  'eclipse-temurin',
  'ſnode:22',
];

const PACKAGES = ['ffmpeg', 'imagemagick', 'libpq-dev', 'postgresql-client-16', 'a+b.c-d', 'a'.repeat(64), 'a'.repeat(65), 'Ffmpeg', 'ffmpeg; rm -rf /', 'a b', '', '한글', '0', '.x', '-x'];

describe('systemPackages: legacy TS와 Rust가 같다', () => {
  it('이미지 이름 18종 × 패키지 목록에서 계열과 결과가 같다', () => {
    for (const image of IMAGES) {
      expect(current.detectPackageFamily(image), image).toEqual(legacy.detectPackageFamily(image));
    }
    const dockerfiles = [
      `# 만든 파일\nFROM node:22-bookworm-slim\n\nWORKDIR /workspace\n`,
      `FROM node:22-alpine\nWORKDIR /workspace\n`,
      `FROM node:22-bookworm-slim\r\nWORKDIR /workspace\r\n`,
      `FROM node:22-bookworm-slim\n${MARK_BEGIN}\nRUN apk add x\n${MARK_END}\nWORKDIR /x\n`,
      `FROM node:22-bookworm-slim\n\n${MARK_BEGIN}\nRUN x\nWORKDIR /x\n`,
      `FROM node:22-bookworm-slim\n${MARK_END}\nWORKDIR /x\n`,
      `FROM node:22-bookworm-slim\n${MARK_BEGIN}\n${MARK_BEGIN}\nRUN x\n${MARK_END}\n${MARK_END}\n`,
      `FROM node:22-bookworm-slim\n${MARK_BEGIN}\n${MARK_END}\n${MARK_BEGIN}\nRUN x\n${MARK_END}\n`,
      `WORKDIR /workspace\n`,
      `\n\n`,
      `FROM    node:22-alpine\n`,
      `FROM\tnode:22-alpine\n`,
      ` FROM node:22-alpine\n`,
      `FROM node:22-alpine\nFROM python:3.12-slim\n`,
    ];
    for (const dockerfile of dockerfiles) {
      for (const packages of [[], ['ffmpeg'], ['ffmpeg', 'imagemagick'], [PACKAGES[4]!], [PACKAGES[8]!], [PACKAGES[10]!], [PACKAGES[1]!, PACKAGES[8]!]]) {
        const label = JSON.stringify({ dockerfile, packages });
        expect(outcome(() => current.applySystemPackages(dockerfile, packages)), label).toEqual(outcome(() => legacy.applySystemPackages(dockerfile, packages)));
      }
    }
  });

  it('무작위 Dockerfile·패키지 3000개에서 결과나 오류 글자가 같다', () => {
    const rand = makeRandom(20_261_120);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
    for (let i = 0; i < 3000; i += 1) {
      const lines = Array.from({ length: int(6) }, () => {
        const kind = int(7);
        if (kind === 0) return `FROM ${pick(IMAGES)}`;
        if (kind === 1) return pick(['', ' ', 'WORKDIR /x', 'RUN echo hi']);
        if (kind === 2) return MARK_BEGIN;
        if (kind === 3) return MARK_END;
        if (kind === 4) return `  FROM ${pick(IMAGES)}`;
        if (kind === 5) return `FROM\t${pick(IMAGES)}`;
        return `# ${pick(IMAGES)}`;
      });
      const dockerfile = lines.join(pick(['\n', '\r\n']));
      const packages = Array.from({ length: int(4) }, () => pick(PACKAGES));
      const label = JSON.stringify({ dockerfile, packages });
      const actual = outcome(() => current.applySystemPackages(dockerfile, packages));
      const expected = outcome(() => legacy.applySystemPackages(dockerfile, packages));
      if (expected.ok) {
        expect(actual, label).toEqual(expected);
      } else {
        expect(actual.ok, label).toBe(false);
        if (!actual.ok) expect(actual.message, label).toBe(expected.message);
      }
    }
  });

  it('오류는 SystemPackageError이고 글자가 같다', () => {
    expect(() => current.applySystemPackages('FROM rust:1-slim\n', ['ffmpeg'])).toThrow(current.SystemPackageError);
    expect(() => current.applySystemPackages('FROM rust:1-slim\n', ['ffmpeg'])).toThrow(
      "'rust:1-slim' 베이스 이미지의 패키지 계열(apt 또는 apk)을 알 수 없어 systemPackages를 설치할 수 없습니다. Debian·Ubuntu(apt) 또는 Alpine(apk) 계열 이미지만 지원합니다 — 다른 계열이면 Dockerfile.b-studio를 직접 고치세요.",
    );
  });
});
