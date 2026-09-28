import { describe, expect, it } from 'vitest';
import { proxyEnvironment } from './edge-config';

describe('proxyEnvironment', () => {
  it('Node 기본 fetch가 프록시를 따르도록 NODE_USE_ENV_PROXY를 넘긴다', () => {
    const environment = proxyEnvironment(['localhost', 'web']);

    expect(environment.NODE_USE_ENV_PROXY).toBe('1');
  });
});
