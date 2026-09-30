import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { offManagedServices, readServiceSelection, serviceSelectionFor, writeServiceSelection } from './service-selection';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-services-'));
  roots.push(root);
  return path.join(root, 'projects');
}

/** commerce(managed)가 mysql에 기대고, redis·kafka는 가져왔지만 아무도 기대지 않는 프로젝트 */
const project = {
  managed: [['commerce', {}]],
  composeServices: ['commerce', 'mysql', 'redis', 'kafka'],
  dependsOn: { commerce: ['mysql'], mysql: [], redis: [], kafka: [] },
} as unknown as LoadedProject;

describe('readServiceSelection', () => {
  it('저장한 파일이 없으면 undefined다', async () => {
    expect(await readServiceSelection('orders', await stateDir())).toBeUndefined();
  });

  it('깨진 JSON이나 selected가 배열이 아니면 undefined다(기본값으로 돌아간다)', async () => {
    const dir = await stateDir();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'orders'), { recursive: true });
    await writeFile(path.join(dir, 'orders', 'services.json'), '{not json');
    expect(await readServiceSelection('orders', dir)).toBeUndefined();

    await writeFile(path.join(dir, 'orders', 'services.json'), JSON.stringify({ selected: 'web' }));
    expect(await readServiceSelection('orders', dir)).toBeUndefined();
  });
});

describe('writeServiceSelection', () => {
  it('선택을 이름 순으로 정렬해 저장하고, 사용자 저장소가 아니라 상태 폴더에 둔다', async () => {
    const dir = await stateDir();
    await writeServiceSelection('orders', ['redis', 'commerce'], dir);

    const saved = await readServiceSelection('orders', dir);
    expect(saved?.selected).toEqual(['commerce', 'redis']);

    const raw = JSON.parse(await readFile(path.join(dir, 'orders', 'services.json'), 'utf8')) as unknown;
    expect(raw).toMatchObject({ version: 1, selected: ['commerce', 'redis'] });
  });

  it('다시 쓰면 지난 선택을 덮어쓴다', async () => {
    const dir = await stateDir();
    await writeServiceSelection('orders', ['commerce', 'mysql'], dir);
    await writeServiceSelection('orders', ['commerce'], dir);
    expect((await readServiceSelection('orders', dir))?.selected).toEqual(['commerce']);
  });
});

describe('serviceSelectionFor', () => {
  it('저장한 선택이 없으면 기본값(관리형 + 기댐 닫힘)을 쓰고, 아무도 기대지 않는 kafka·redis는 빠진다', async () => {
    const resolved = await serviceSelectionFor(project, 'orders', await stateDir());
    expect(resolved).toEqual({ selected: ['commerce', 'mysql'], isDefault: true });
  });

  it('저장한 선택이 있으면 그것을 쓴다(개발만 프리셋처럼 mysql도 뺄 수 있다)', async () => {
    const dir = await stateDir();
    await writeServiceSelection('orders', ['commerce'], dir);
    expect(await serviceSelectionFor(project, 'orders', dir)).toEqual({ selected: ['commerce'], isDefault: false });
  });

  it('저장한 선택에 compose에서 없어진 서비스가 있으면 걸러내고, 그래도 남으면 그대로 쓴다', async () => {
    const dir = await stateDir();
    await writeServiceSelection('orders', ['commerce', 'removed-service'], dir);
    expect(await serviceSelectionFor(project, 'orders', dir)).toEqual({ selected: ['commerce'], isDefault: false });
  });

  it('저장한 선택이 전부 걸러져 하나도 안 남으면 기본값으로 돌아간다', async () => {
    const dir = await stateDir();
    await writeServiceSelection('orders', ['removed-service'], dir);
    expect(await serviceSelectionFor(project, 'orders', dir)).toEqual({ selected: ['commerce', 'mysql'], isDefault: true });
  });

  it('프로젝트마다 다른 폴더에 둬 서로 섞이지 않는다', async () => {
    const dir = await stateDir();
    await writeServiceSelection('orders', ['commerce'], dir);
    expect(await serviceSelectionFor(project, 'billing', dir)).toEqual({ selected: ['commerce', 'mysql'], isDefault: true });
  });
});

describe('offManagedServices', () => {
  it('선택에 없는 managed 서비스 이름을 돌려준다', () => {
    const multi = { managed: [['web', {}], ['api', {}], ['worker', {}]] } as unknown as LoadedProject;
    expect(offManagedServices(multi, new Set(['web']))).toEqual(new Set(['api', 'worker']));
  });

  it('전부 선택했으면 빈 집합이다', () => {
    expect(offManagedServices(project, new Set(['commerce', 'mysql']))).toEqual(new Set());
  });
});
