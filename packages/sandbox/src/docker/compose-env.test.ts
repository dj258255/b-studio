import { describe, expect, it } from 'vitest';
import { composeEnvironment } from './compose-env';

describe('compose CLI에 넘기는 환경', () => {
  it('CLI가 쓰는 이름과 선언된 시크릿만 넘기고 studio의 다른 환경 변수는 넘기지 않는다', () => {
    const env = composeEnvironment(
      { DB_PASSWORD: 's3cret' },
      {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        DOCKER_HOST: 'unix:///Users/me/.colima/default/docker.sock',
        DOCKER_CONFIG: '/Users/me/.docker',
        COMPOSE_BAKE: 'true',
        BUILDKIT_PROGRESS: 'plain',
        LC_ALL: 'C',
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
        GITHUB_TOKEN: 'ghp_xxx',
        AWS_SECRET_ACCESS_KEY: 'aws',
        B_STUDIO_GATE_TOKEN: 'gate',
      },
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      DOCKER_HOST: 'unix:///Users/me/.colima/default/docker.sock',
      DOCKER_CONFIG: '/Users/me/.docker',
      COMPOSE_BAKE: 'true',
      BUILDKIT_PROGRESS: 'plain',
      LC_ALL: 'C',
      DB_PASSWORD: 's3cret',
    });
  });

  it('선언된 시크릿이 같은 이름의 studio 환경 변수보다 앞선다', () => {
    expect(composeEnvironment({ PATH: 'secret-wins' }, { PATH: '/usr/bin' }).PATH).toBe('secret-wins');
  });
});
