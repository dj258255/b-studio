import { describe, expect, it } from 'vitest';
import { classifyOwnership, discoverUserContainers, matchesProjectRoot, mergeHostContainerStats, parseHostContainers, type HostContainer } from './host-containers';

function inspectRow(overrides: {
  id?: string;
  name?: string;
  status?: string;
  labels?: Record<string, string>;
  ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }>>;
}): object {
  return {
    Id: overrides.id ?? 'abc123',
    Name: `/${overrides.name ?? 'some-container'}`,
    State: { Status: overrides.status ?? 'running' },
    Config: { Labels: overrides.labels ?? {} },
    NetworkSettings: { Ports: overrides.ports ?? {} },
  };
}

describe('parseHostContainers', () => {
  it('compose 라벨과 포트를 읽는다', () => {
    const [row] = parseHostContainers(
      JSON.stringify([
        inspectRow({
          name: 'myapp-db-1',
          labels: { 'com.docker.compose.project': 'myapp', 'com.docker.compose.service': 'db', 'com.docker.compose.project.working_dir': '/Users/me/myapp' },
          ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }, { HostIp: '::', HostPort: '5432' }] },
        }),
      ]),
    );
    expect(row).toMatchObject({
      name: 'myapp-db-1',
      owner: 'user',
      composeProject: 'myapp',
      composeService: 'db',
      composeWorkingDir: '/Users/me/myapp',
    });
    // IPv4/IPv6 중복 바인딩에서 IPv4 하나만 대표로 남는다
    expect(row!.ports).toEqual([{ containerPort: 5432, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 5432 }]);
  });

  it('알 수 없는 state는 unknown으로 둔다', () => {
    const [row] = parseHostContainers(JSON.stringify([inspectRow({ status: 'weird-state' })]));
    expect(row!.state).toBe('unknown');
  });

  it('빈 입력은 빈 배열', () => {
    expect(parseHostContainers('')).toEqual([]);
    expect(parseHostContainers('  ')).toEqual([]);
  });
});

describe('classifyOwnership', () => {
  it('b-studio.sandbox 라벨이 있으면 sandbox', () => {
    expect(classifyOwnership({ 'b-studio.sandbox': 's1' })).toBe('sandbox');
  });
  it('b-studio.deploy 라벨이 있으면 deploy', () => {
    expect(classifyOwnership({ 'b-studio.deploy': 'orders' })).toBe('deploy');
  });
  it('둘 다 없으면 user', () => {
    expect(classifyOwnership({ 'com.docker.compose.project': 'myapp' })).toBe('user');
  });
});

describe('matchesProjectRoot', () => {
  it('정확히 같은 경로면 true', () => {
    expect(matchesProjectRoot('/Users/me/myapp', '/Users/me/myapp')).toBe(true);
  });
  it('하위 폴더면 true', () => {
    expect(matchesProjectRoot('/Users/me/myapp/backend', '/Users/me/myapp')).toBe(true);
  });
  it('다른 폴더면 false (접두사만 같은 다른 이름의 폴더도 제외)', () => {
    expect(matchesProjectRoot('/Users/me/other', '/Users/me/myapp')).toBe(false);
    expect(matchesProjectRoot('/Users/me/myapp-other', '/Users/me/myapp')).toBe(false);
  });
  it('working_dir가 없으면 false', () => {
    expect(matchesProjectRoot(undefined, '/Users/me/myapp')).toBe(false);
  });
});

describe('discoverUserContainers', () => {
  const PROJECT_ROOT = '/Users/me/myapp';

  function userContainer(overrides: Partial<HostContainer> = {}): HostContainer {
    return {
      id: 'id1',
      name: 'myapp-web-1',
      owner: 'user',
      composeProject: 'myapp',
      composeService: 'web',
      composeWorkingDir: PROJECT_ROOT,
      oneOff: false,
      state: 'running',
      ports: [],
      labels: {},
      ...overrides,
    };
  }

  it('프로젝트 폴더에서 뜬 user 컨테이너만 compose 프로젝트로 묶는다', () => {
    const groups = discoverUserContainers([userContainer(), userContainer({ id: 'id2', name: 'myapp-db-1', composeService: 'db' })], PROJECT_ROOT);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.project).toBe('myapp');
    expect(groups[0]!.services.map((service) => service.composeService)).toEqual(['web', 'db']);
  });

  it('다른 폴더의 컨테이너는 뺀다', () => {
    const groups = discoverUserContainers([userContainer({ composeWorkingDir: '/Users/me/other-project' })], PROJECT_ROOT);
    expect(groups).toEqual([]);
  });

  it('b-studio 샌드박스·배포 컨테이너는 뺀다', () => {
    const groups = discoverUserContainers(
      [userContainer({ owner: 'sandbox', composeProject: 'studio-myapp-ab12' }), userContainer({ id: 'id2', owner: 'deploy', composeProject: 'bsd-myapp' })],
      PROJECT_ROOT,
    );
    expect(groups).toEqual([]);
  });

  it('일회성(oneoff) 컨테이너는 뺀다', () => {
    const groups = discoverUserContainers([userContainer({ oneOff: true })], PROJECT_ROOT);
    expect(groups).toEqual([]);
  });

  it('compose 프로젝트 라벨이 없으면(순수 docker run) 뺀다', () => {
    const groups = discoverUserContainers([userContainer({ composeProject: undefined })], PROJECT_ROOT);
    expect(groups).toEqual([]);
  });
});

describe('mergeHostContainerStats', () => {
  function userContainer(name: string): HostContainer {
    return { id: 'id1', name, owner: 'user', oneOff: false, state: 'running', ports: [], labels: {} };
  }

  it('이름이 같은 stats 행의 CPU·메모리를 붙인다', () => {
    const stats = '{"Name":"myapp-web-1","CPUPerc":"1.5%","MemUsage":"10MiB / 1GiB"}';
    const [merged] = mergeHostContainerStats([userContainer('myapp-web-1')], stats);
    expect(merged!.cpuPercent).toBeCloseTo(1.5);
    expect(merged!.memoryBytes).toBe(10 * 1024 ** 2);
  });

  it('맞는 stats가 없으면(죽은 컨테이너 등) undefined로 둔다', () => {
    const [merged] = mergeHostContainerStats([userContainer('myapp-web-1')], '');
    expect(merged!.cpuPercent).toBeUndefined();
    expect(merged!.memoryBytes).toBeUndefined();
  });
});
