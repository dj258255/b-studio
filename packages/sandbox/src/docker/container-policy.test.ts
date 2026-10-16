import { describe, expect, it } from 'vitest';
import { findPolicyViolations, isSensitiveHostPath, type InspectedContainerPolicy } from './container-policy';

const OPTIONS = { projectName: 'sb1', sandboxNetwork: 'b-studio-sandbox', egressNetwork: 'b-studio-egress', edgeService: 'b-studio-edge' };

/** compose가 b-studio override대로 만든 서비스 컨테이너의 inspect 모양 */
function service(name: string, overrides: { HostConfig?: object; Networks?: Record<string, object>; Mounts?: object[] } = {}): InspectedContainerPolicy {
  return {
    Id: `id-${name}`,
    Config: { Labels: { 'com.docker.compose.service': name } },
    HostConfig: { Privileged: false, CapAdd: null, SecurityOpt: null, PidMode: '', IpcMode: 'private', NetworkMode: 'sb1_b-studio-sandbox', PortBindings: {}, ...overrides.HostConfig },
    NetworkSettings: { Networks: overrides.Networks ?? { 'sb1_b-studio-sandbox': {} } },
    Mounts: (overrides.Mounts ?? []) as InspectedContainerPolicy['Mounts'],
  };
}

describe('만든 컨테이너의 격리 검사', () => {
  it('override대로 만든 서비스와 edge는 통과한다', () => {
    expect(findPolicyViolations(service('api', { Mounts: [{ Type: 'bind', Source: '/Users/me/shop' }, { Type: 'volume', Source: '/var/lib/docker/volumes/x/_data' }] }), OPTIONS)).toEqual([]);
    const edge = service('b-studio-edge', {
      Networks: { 'sb1_b-studio-sandbox': {}, 'sb1_b-studio-egress': {} },
      HostConfig: { PortBindings: { '18080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
    });
    expect(findPolicyViolations(edge, OPTIONS)).toEqual([]);
  });

  it('권한을 올리는 설정을 모두 잡는다', () => {
    const problems = findPolicyViolations(
      service('api', {
        HostConfig: {
          Privileged: true,
          CapAdd: ['CAP_SYS_ADMIN'],
          Devices: [{ PathOnHost: '/dev/kvm' }],
          DeviceRequests: [{ Driver: 'nvidia' }],
          SecurityOpt: ['seccomp=unconfined', 'apparmor=unconfined', 'label=disable', 'no-new-privileges=false'],
        },
      }),
      OPTIONS,
    );
    expect(problems).toEqual([
      'privileged',
      'cap_add: CAP_SYS_ADMIN',
      'devices',
      'device_requests(gpus)',
      'security_opt: seccomp=unconfined',
      'security_opt: apparmor=unconfined',
      'security_opt: label=disable',
      'security_opt: no-new-privileges=false',
    ]);
  });

  it('호스트나 다른 컨테이너의 네임스페이스를 쓰면 잡는다(edge의 네트워크를 빌려 쓰는 경우 포함)', () => {
    const problems = findPolicyViolations(
      service('api', { HostConfig: { PidMode: 'host', IpcMode: 'container:abc', UTSMode: 'host', UsernsMode: 'host', CgroupnsMode: 'host', NetworkMode: 'container:edge-id' } }),
      OPTIONS,
    );
    expect(problems).toEqual(['pid: host', 'ipc: container:abc', 'uts: host', 'userns_mode: host', 'cgroup: host', 'network_mode: container:edge-id']);
    expect(findPolicyViolations(service('api', { HostConfig: { NetworkMode: 'host' }, Networks: { host: {} } }), OPTIONS)).toEqual(['network_mode: host', 'networks: host']);
  });

  it('sandbox 네트워크 밖의 네트워크(default 포함)에 붙으면 잡는다. egress는 edge만 쓸 수 있다', () => {
    expect(findPolicyViolations(service('api', { Networks: { 'sb1_b-studio-sandbox': {}, sb1_default: {} } }), OPTIONS)).toEqual(['networks: sb1_default']);
    expect(findPolicyViolations(service('api', { Networks: { 'sb1_b-studio-sandbox': {}, 'sb1_b-studio-egress': {} } }), OPTIONS)).toEqual(['networks: sb1_b-studio-egress']);
    // 다른 샌드박스의 같은 이름 네트워크도 이 샌드박스의 것이 아니다
    expect(findPolicyViolations(service('api', { Networks: { 'sb2_b-studio-sandbox': {} } }), OPTIONS)).toEqual(['networks: sb2_b-studio-sandbox']);
  });

  it('edge가 아닌 서비스가 포트를 공개하면 잡는다', () => {
    expect(findPolicyViolations(service('api', { HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }], '81/tcp': null } } }), OPTIONS)).toEqual(['ports: 80/tcp']);
  });

  it('도커 소켓과 시스템 폴더를 붙이면 잡는다', () => {
    const problems = findPolicyViolations(
      service('api', {
        Mounts: [
          { Type: 'bind', Source: '/var/run/docker.sock' },
          { Type: 'bind', Source: '/Users/me/.colima/default/docker.sock' },
          { Type: 'bind', Source: '/' },
          { Type: 'bind', Source: '/etc/' },
        ],
      }),
      OPTIONS,
    );
    expect(problems).toEqual(['호스트 경로 마운트: /var/run/docker.sock', '호스트 경로 마운트: /Users/me/.colima/default/docker.sock', '호스트 경로 마운트: /', '호스트 경로 마운트: /etc/']);
  });

  it('studio라는 이름의 서비스는 edge가 studio 자신의 호출로 보므로 잡는다', () => {
    expect(findPolicyViolations(service('studio'), OPTIONS)).toEqual(["서비스 이름 'studio'는 쓸 수 없습니다(edge가 studio의 호출로 봅니다)"]);
  });

  it('edge에 덧붙인 권한도 잡는다(사용자 compose의 같은 이름 서비스가 override와 합쳐진 경우)', () => {
    const edge = service('b-studio-edge', { Networks: { 'sb1_b-studio-sandbox': {}, 'sb1_b-studio-egress': {} }, HostConfig: { Privileged: true }, Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock' }] });
    expect(findPolicyViolations(edge, OPTIONS)).toEqual(['privileged', '호스트 경로 마운트: /var/run/docker.sock']);
  });
});

describe('호스트 경로 판정(거부 목록)', () => {
  it('시스템 폴더와 그 아래, 소켓, 모양을 모르는 경로는 걸린다', () => {
    for (const source of ['/', '/proc', '/sys/fs', '/dev', '/run/containerd', '/var/run', '/var/lib/docker/overlay2', '/boot', '/etc/../etc/passwd', 'relative/path', '/tmp/x/podman.sock', '//etc']) {
      expect(isSensitiveHostPath(source), source).toBe(true);
    }
  });

  it('프로젝트 폴더·모노레포 상위 폴더·Docker Desktop의 호스트 폴더 자리는 걸리지 않는다', () => {
    for (const source of ['/Users/me/shop', '/Users/me', '/home/me/repo', '/private/tmp/x', '/run/desktop/mnt/host/c/Users/me/shop', '/host_mnt/Users/me/shop', 'C:\\Users\\me\\shop', '/etcetera']) {
      expect(isSensitiveHostPath(source), source).toBe(false);
    }
  });

  it('Docker Desktop의 호스트 폴더 자리라도 ..로 빠져나가면 걸린다', () => {
    expect(isSensitiveHostPath('/run/desktop/mnt/host/../../../etc')).toBe(true);
  });
});
