import { describe, expect, it } from 'vitest';
import { findPublicUrlRefs, hasPublicUrlPlaceholder, publicUrlPlaceholder, resolvePublicUrlPlaceholders } from './public-url';

describe('publicUrlPlaceholder·resolvePublicUrlPlaceholders', () => {
  it('자리 표시자를 만들고, 값 안의 자리 표시자를 resolve가 돌려주는 주소로 바꾼다', () => {
    expect(publicUrlPlaceholder('backend')).toBe('${b-studio:services.backend.publicUrl}');
    expect(resolvePublicUrlPlaceholders('${b-studio:services.backend.publicUrl}/api', () => 'http://127.0.0.1:40123')).toBe('http://127.0.0.1:40123/api');
    // 접미사가 없어도 그대로 바뀐다
    expect(resolvePublicUrlPlaceholders('${b-studio:services.backend.publicUrl}', () => 'http://127.0.0.1:1')).toBe('http://127.0.0.1:1');
    // 자리 표시자가 없으면 값을 그대로 돌려준다
    expect(resolvePublicUrlPlaceholders('http://backend:8080', () => 'unused')).toBe('http://backend:8080');
  });

  it('값 하나에 자리 표시자가 둘 이상이면 서비스별로 맞는 주소를 찾아 바꾼다', () => {
    const resolve = (service: string) => (service === 'backend' ? 'http://127.0.0.1:1' : 'http://127.0.0.1:2');
    expect(resolvePublicUrlPlaceholders('${b-studio:services.backend.publicUrl} ${b-studio:services.worker.publicUrl}', resolve)).toBe('http://127.0.0.1:1 http://127.0.0.1:2');
  });

  it('hasPublicUrlPlaceholder는 자리 표시자가 있을 때만 참이다', () => {
    expect(hasPublicUrlPlaceholder('${b-studio:services.backend.publicUrl}/api')).toBe(true);
    expect(hasPublicUrlPlaceholder('http://localhost:8080')).toBe(false);
  });

  it('docker compose 자신의 치환 문법(${VAR}, ${VAR:-default})과 섞여 있어도 자리 표시자만 본다', () => {
    // compose의 ${VAR:-default}는 변수 이름에 하이픈·콜론·점이 없어 우리 자리 표시자와 겹치지 않는다
    expect(hasPublicUrlPlaceholder('${BACKEND_PORT:-8080}')).toBe(false);
    expect(resolvePublicUrlPlaceholders('${BACKEND_PORT:-8080}/${b-studio:services.backend.publicUrl}', () => 'http://127.0.0.1:1')).toBe('${BACKEND_PORT:-8080}/http://127.0.0.1:1');
  });
});

describe('findPublicUrlRefs', () => {
  it('맵 문법 environment에서 자리 표시자가 있는 항목을 찾는다', () => {
    const services = {
      frontend: { build: './frontend', environment: { NEXT_PUBLIC_API_BASE_URL: '${b-studio:services.backend.publicUrl}/api', PORT: '3000' } },
      backend: { build: './backend' },
    };
    expect(findPublicUrlRefs(services)).toEqual([
      { service: 'frontend', envKey: 'NEXT_PUBLIC_API_BASE_URL', template: '${b-studio:services.backend.publicUrl}/api', targetService: 'backend' },
    ]);
  });

  it('목록 문법("KEY=value")도 본다', () => {
    const services = { frontend: { environment: ['NEXT_PUBLIC_API_BASE_URL=${b-studio:services.backend.publicUrl}', 'PORT=3000'] } };
    expect(findPublicUrlRefs(services)).toEqual([
      { service: 'frontend', envKey: 'NEXT_PUBLIC_API_BASE_URL', template: '${b-studio:services.backend.publicUrl}', targetService: 'backend' },
    ]);
  });

  it('자리 표시자가 없거나 environment가 없으면 빈 배열이다', () => {
    expect(findPublicUrlRefs({ frontend: { build: './frontend' } })).toEqual([]);
    expect(findPublicUrlRefs({ frontend: { environment: { API_URL: 'http://backend:8080' } } })).toEqual([]);
    expect(findPublicUrlRefs({})).toEqual([]);
  });
});
