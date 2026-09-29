import path from 'node:path';
import { loadProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';

// allowedTools를 적은 프로젝트는 목록에 없는 도구를 모델에게 보이지도 않는다.
// 예제가 플랫폼 도구를 빼먹으면 그 기능이 조용히 꺼진다(E2 첫 시작의 게시판 도구, 되묻기 첫 확인에서 실제로 그랬다)
describe('예제 프로젝트의 허용 도구', () => {
  it('examples/orders는 되묻기 도구를 허용한다', async () => {
    const project = await loadProject(path.resolve(import.meta.dirname, '../../../../examples/orders'));
    expect(project.spec.workflow?.allowedTools).toContain('ask_user');
  });
});
