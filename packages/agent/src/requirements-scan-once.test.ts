import { describe, expect, it, vi } from 'vitest';

vi.mock('./test-discovery', async (original) => {
  const actual = await original<typeof import('./test-discovery')>();
  return { ...actual, discoverTestsInFile: vi.fn(actual.discoverTestsInFile) };
});

import { scanTestFilesForOrphans, scanTestFilesForRequirementId, scanTestFilesForScenarioId, type ScannedFile } from './requirements';
import { discoverTestsInFile } from './test-discovery';

const java = (name: string, body: string): ScannedFile => ({ path: `commerce/src/test/java/${name}Test.java`, content: `class ${name}Test {\n${body}\n}\n` });

describe('요구사항별 테스트 훑기는 파일을 한 번만 해석한다 (트러블슈팅 122)', () => {
  it('같은 파일 목록으로 요구사항 30개·시나리오·주인 없는 테스트를 훑어도 파일마다 한 번만 해석한다', () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      java(`Order${index}`, `  @Nested\n  @DisplayName("R${index + 1} 주문")\n  class Flow {\n    @Test\n    @DisplayName("R${index + 1}.1 담는다")\n    void addsToCart() {}\n    @Test\n    void plain() {}\n  }\n  @Test\n  void testR${index + 1}Login() {}`),
    );
    vi.mocked(discoverTestsInFile).mockClear();

    for (let id = 1; id <= 30; id++) scanTestFilesForRequirementId(files, `R${id}`);
    scanTestFilesForScenarioId(files, 'R3.1');
    scanTestFilesForOrphans(files);

    // 고치기 전에는 훑을 때마다 파일을 다시 해석해 20 × 32 = 640번이었다
    expect(vi.mocked(discoverTestsInFile)).toHaveBeenCalledTimes(files.length);
  });

  it('한 번만 해석해도 결과는 같다: 묶음 제목의 id, 테스트 이름의 id, 메서드 이름의 id', () => {
    const file = java('Order', `  @Nested\n  @DisplayName("R3 주문")\n  class Flow {\n    @Test\n    @DisplayName("담는다")\n    void addsToCart() {}\n    @Test\n    @DisplayName("R4.1 결제한다")\n    void pays() {}\n  }\n  @Test\n  void testR31Login() {}\n  @Test\n  void testR3Logout() {}`);
    const files = [file];
    // 묶음의 @DisplayName도 선언된 이름으로 잡힌다(고치기 전과 같다)
    expect(scanTestFilesForRequirementId(files, 'R3').map((match) => match.name)).toEqual(['R3 주문', '담는다', 'R4.1 결제한다', 'testR3Logout']);
    expect(scanTestFilesForRequirementId(files, 'R4').map((match) => match.name)).toEqual(['R4.1 결제한다']);
    // R3은 R31에 걸리지 않고, R31은 자기 메서드에만 걸린다
    expect(scanTestFilesForRequirementId(files, 'R31').map((match) => match.name)).toEqual(['testR31Login']);
    expect(scanTestFilesForScenarioId(files, 'R4.1').map((match) => match.name)).toEqual(['R4.1 결제한다']);
    expect(scanTestFilesForOrphans(files)).toEqual([]);
  });

  it('같은 파일 객체의 내용이 바뀌면 다시 해석한다(낡은 결과를 돌려주지 않는다)', () => {
    const file: ScannedFile = { path: 'web/cart.test.ts', content: `it('R1 담는다', () => {});\n` };
    expect(scanTestFilesForRequirementId([file], 'R1')).toHaveLength(1);
    file.content = `it('R2 뺀다', () => {});\n`;
    expect(scanTestFilesForRequirementId([file], 'R1')).toHaveLength(0);
    expect(scanTestFilesForRequirementId([file], 'R2').map((match) => match.name)).toEqual(['R2 뺀다']);
  });
});
