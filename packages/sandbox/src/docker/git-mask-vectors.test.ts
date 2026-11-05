import { describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import { boundDevice, collectHostMounts, planEvaluationAssetMask, planGitMask } from './git-mask';

/**
 * git-mask의 판정을 Rust로 옮기면서(ADR-191 2단계 첫 묶음) Node `path`와 다르게 읽기 쉬운 입력과 의도한 차이를 고정한다.
 * 기대값은 옮기기 전 TS 구현의 값이다. "의도한 차이"라고 적은 테스트만 다르다
 */
describe('Node path와 같은 경로 규칙', () => {
  it('루트(`/`)를 마운트해도 그 아래 `.git`을 덮는다', () => {
    expect(planGitMask([{ service: 'a', source: '/', target: '/host' }], [{ dir: '/p', kind: 'directory', hasState: false }])).toEqual({
      a: [{ type: 'bind', source: '/p/.git', target: '/host/p/.git', read_only: true, bind: { create_host_path: false } }],
    });
  });

  it('같은 자리를 둘이 덮으면 상태 폴더를 가리는 빈 폴더가 남는다', () => {
    const plan = planGitMask(
      [
        { service: 'a', source: '/p', target: '/app' },
        { service: 'a', source: '/p/.git', target: '/app/.git/b-studio' },
      ],
      [{ dir: '/p', kind: 'directory', hasState: true }],
    );
    expect(plan.a!.find((volume) => volume.target === '/app/.git/b-studio')!.source).toBe('/p/.git/b-studio-empty');
  });

  it('끝의 `/`, 겹친 구분자, `.`·`..`를 풀어 비교한다', () => {
    const plan = planGitMask([{ service: 'api', source: '/x/../p//./', target: '/app/' }], [{ dir: '/p', kind: 'directory', hasState: true }]);
    expect(plan).toEqual({
      api: [
        { type: 'bind', source: '/p/.git', target: '/app/.git', read_only: true, bind: { create_host_path: false } },
        { type: 'bind', source: '/p/.git/b-studio-empty', target: '/app/.git/b-studio', read_only: true, bind: { create_host_path: false } },
      ],
    });
  });

  it('volumes_from을 따라 물려받은 마운트를 서비스 순서대로 펼친다', () => {
    const mounts = collectHostMounts({
      services: { b: { volumes_from: ['a:ro'] }, a: { volumes: [{ type: 'bind', source: '/p/', target: '/app' }] } },
    });
    expect(mounts).toEqual([
      { service: 'b', source: '/p', target: '/app' },
      { service: 'a', source: '/p', target: '/app' },
    ]);
  });
});

describe('의도한 차이', () => {
  it('이름이 `..`로 시작하는 프로젝트 폴더의 `.git`도 덮는다(옛 TS는 바깥으로 읽어 덮지 않았다 — 고친 구멍)', () => {
    const plan = planGitMask([{ service: 'api', source: '/m', target: '/w' }], [{ dir: '/m/..proj', kind: 'directory', hasState: true }]);
    expect(plan.api!.map((volume) => [volume.source, volume.target])).toEqual([
      ['/m/..proj/.git', '/w/..proj/.git'],
      ['/m/..proj/.git/b-studio-empty', '/w/..proj/.git/b-studio'],
    ]);
  });

  it('서비스 안 마운트는 UTF-16 순서로 정렬한다(옛 TS는 localeCompare라 /a/b가 /a/B보다 앞)', () => {
    const plan = planEvaluationAssetMask([{ service: 's', source: '/p', target: '/a' }], '/p', [
      { path: 'b', source: '/c1' },
      { path: 'B', source: '/c2' },
    ]);
    expect(plan.s!.map((volume) => volume.target)).toEqual(['/a/B', '/a/b']);
  });

  it('볼륨 설정의 모양을 모르면 샌드박스 오류로 멈춘다(옛 TS는 TypeError로 멈췄다)', () => {
    expect(() => boundDevice({ driver_opts: { o: 1 as never, device: '/h' } })).toThrow(SandboxError);
  });
});
