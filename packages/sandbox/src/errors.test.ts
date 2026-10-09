import { describe, expect, it } from 'vitest';
import { isDockerUnreachable, SandboxError } from './errors';

describe('SandboxError.platform', () => {
  it('표시하지 않으면 플랫폼 쪽 실패가 아니다(코드가 원인일 수 있는 실패가 기본이다)', () => {
    expect(new SandboxError('docker compose up 실패', 'build failed').platform).toBe(false);
    expect(new SandboxError('가릴 빈 폴더를 준비하지 못했습니다', 'EEXIST', { platform: true }).platform).toBe(true);
    expect(new SandboxError('x', 'detail', { platform: true }).message).toBe('x\ndetail');
  });
});

describe('isDockerUnreachable', () => {
  it('도커 데몬에 닿지 못했다는 출력을 알아본다', () => {
    expect(isDockerUnreachable('Cannot connect to the Docker daemon at unix:///Users/x/.colima/default/docker.sock. Is the docker daemon running?')).toBe(true);
    expect(isDockerUnreachable('error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": EOF')).toBe(true);
    expect(isDockerUnreachable('dial unix /var/run/docker.sock: connect: connection refused')).toBe(true);
  });

  it('빌드 실패나 서비스 오류는 닿지 못한 것이 아니다', () => {
    expect(isDockerUnreachable('failed to solve: process "/bin/sh -c ./gradlew build" did not complete successfully: exit code: 1')).toBe(false);
    expect(isDockerUnreachable('Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:8080 failed: port is already allocated')).toBe(false);
    expect(isDockerUnreachable('')).toBe(false);
  });
});
