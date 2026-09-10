import { describe, expect, it } from 'vitest';
import { composeVolumeName, describeSnapshotEvent, snapshotName, snapshotsToPrune } from './snapshots';

const base = { project: 'orders', service: 'web', volume: 'web-node-modules' };
const lockfile = { path: 'pnpm-lock.yaml', content: Buffer.from('lockfileVersion: 9.0\n') };
const manifest = { path: 'package.json', content: Buffer.from('{"name":"web"}') };

describe('snapshotName', () => {
  it('키 파일 순서와 무관하고, 내용이 같으면 같은 이름이다', () => {
    const name = snapshotName({ ...base, files: [lockfile, manifest] });
    expect(name).toMatch(/^b-studio-snapshot-[0-9a-f]{24}$/);
    expect(snapshotName({ ...base, files: [manifest, lockfile] })).toBe(name);
  });

  it('파일 내용, 파일 유무, 프로젝트가 다르면 다른 이름이다', () => {
    const name = snapshotName({ ...base, files: [lockfile, manifest] });
    expect(snapshotName({ ...base, files: [{ ...lockfile, content: Buffer.from('lockfileVersion: 9.1\n') }, manifest] })).not.toBe(name);
    expect(snapshotName({ ...base, files: [lockfile, { path: 'package.json', content: undefined }] })).not.toBe(name);
    expect(snapshotName({ ...base, project: 'billing', files: [lockfile, manifest] })).not.toBe(name);
  });

  it('파일 경계를 옮겨 붙인 내용은 같은 이름이 되지 않는다', () => {
    const a = snapshotName({ ...base, files: [{ path: 'a', content: Buffer.from('xy') }, { path: 'b', content: Buffer.from('z') }] });
    const b = snapshotName({ ...base, files: [{ path: 'a', content: Buffer.from('x') }, { path: 'b', content: Buffer.from('yz') }] });
    expect(a).not.toBe(b);
  });
});

describe('snapshotsToPrune', () => {
  it('최근 스냅샷만 남기고 오래된 이름을 돌려준다', () => {
    const output = [
      'b-studio-snapshot-old 2026-09-01T10:00:00Z',
      'b-studio-snapshot-new 2026-09-11T10:00:00Z',
      'b-studio-snapshot-mid 2026-09-05T10:00:00Z',
      '',
    ].join('\n');
    expect(snapshotsToPrune(output)).toEqual(['b-studio-snapshot-old']);
    expect(snapshotsToPrune(output, 1)).toEqual(['b-studio-snapshot-mid', 'b-studio-snapshot-old']);
  });
});

describe('composeVolumeName · describeSnapshotEvent', () => {
  it('compose가 붙이는 볼륨 이름과 알림 문구를 만든다', () => {
    expect(composeVolumeName('studio-orders-1f2e5b', 'web-node-modules')).toBe('studio-orders-1f2e5b_web-node-modules');
    expect(describeSnapshotEvent({ service: 'web', volume: 'web-node-modules', snapshot: 's', action: 'seeded', elapsedMs: 820 })).toBe(
      'web-node-modules 볼륨을 스냅샷에서 채웠습니다 (0.8초)',
    );
  });
});
