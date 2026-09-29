/**
 * 디자인(Figma) 자료원. 에이전트 도구는 이 인터페이스만 알고, 실제 Figma 호출은 스튜디오 서버가 구현해 넘긴다.
 * 이미지는 모델에 넘기지 않고 산출물로 저장한 참조 경로만 돌려준다(원격 브라우저의 요소 선택과 같은 이유:
 * 모델마다 이미지 입력 지원이 달라, 한쪽에 맞춘 이미지 형식이 다른 쪽에서 오류가 되거나 무시된다).
 */

export interface DesignFrameInfo {
  id: string;
  name: string;
  /** 프레임이 속한 페이지 이름 */
  page: string;
  width: number;
  height: number;
}

export interface DesignSource {
  /** 파일의 페이지별 프레임 목록 */
  frames(): Promise<DesignFrameInfo[]>;
  /** 한 프레임의 구조·스타일 요약과 PNG */
  frame(id: string): Promise<{ summary: string; png: Buffer }>;
  /** PNG를 산출물로 저장하고 식별자(참조 경로)를 돌려준다 */
  saveArtifact(name: string, data: Buffer): Promise<string>;
}
