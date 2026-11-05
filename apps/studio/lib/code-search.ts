/** 코드 탭의 내용 찾기. 파일을 읽는 일은 서버가 하고, 줄을 고르는 규칙만 따로 두어 테스트한다 */
export interface CodeMatch {
  /** 1부터 세는 줄 번호 */
  line: number;
  /** 보여 줄 줄 내용. 아주 긴 줄은 맞은 자리 주변만 남긴다 */
  text: string;
  /** text 안에서 맞은 자리 */
  start: number;
  length: number;
}
