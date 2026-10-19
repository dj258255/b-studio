/**
 * 시작에 실패한 세션의 오류 원문을 화면에 맞게 다듬는다(#718).
 * 원문은 그대로 두고 "자세히"에서 펼친다. 여기서는 요약 한 줄과, 알려진 실패일 때만 원인과 조치를 만든다
 */

export interface StartFailureHint {
  /** 무엇이 일어났는지 */
  cause: string;
  /** 사람이 할 일 */
  action: string;
}

const TOO_MANY_OPEN_FILES = /\bEMFILE\b|too many open files|os error 24\b/i;
const MISSING_FILE = /\bENOENT\b|no such file or directory/i;
/** macOS·리눅스의 홈 폴더. Colima는 기본으로 여기만 VM에 마운트한다 */
const HOME_PREFIX = /^\/(Users|home)\/[^/]+\//;

/**
 * 오류 원문에서 알려진 실패 꼴을 찾아 원인과 조치를 돌려준다. 모르는 꼴이면 짐작하지 않고 undefined다.
 * workDir은 컨테이너에 마운트하는 프로젝트 폴더(호스트 경로)다. 홈 폴더 밖이면 VM이 마운트하지 못했을 가능성을 앞에 둔다
 */
export function startFailureHint(raw: string, { workDir }: { workDir?: string } = {}): StartFailureHint | undefined {
  if (TOO_MANY_OPEN_FILES.test(raw)) {
    return {
      cause: '컨테이너가 열 수 있는 파일 수 한도에 걸려 종료됐습니다.',
      action:
        '개발 서버의 파일 감시가 Docker VM의 한도를 넘었을 수 있습니다. Colima라면 colima ssh -- sudo sysctl -w fs.inotify.max_user_instances=1024 로 한도를 올린 뒤 다시 시작하세요.',
    };
  }
  if (MISSING_FILE.test(raw)) {
    const outsideHome = workDir !== undefined && !HOME_PREFIX.test(workDir);
    return {
      cause: '컨테이너 안에서 프로젝트 파일을 찾지 못했습니다.',
      action: outsideHome
        ? `Docker VM이 이 폴더를 마운트하지 못했을 수 있습니다. Colima는 기본으로 홈 폴더만 마운트하므로 프로젝트를 홈 폴더 아래로 옮기거나 VM 마운트에 ${workDir}를 더한 뒤 다시 시작하세요.`
        : '파일이 프로젝트에 있는지 확인하세요. 파일이 있다면 Docker VM이 이 폴더를 마운트하지 못했을 수 있습니다.',
    };
  }
  return undefined;
}

/**
 * 오류 원문의 첫 줄을 요약으로 쓴다. 너무 길면 잘라 말줄임표를 붙인다.
 * truncated는 요약이 원문과 달라 "자세히"로 펼쳐 볼 것이 있는지다
 */
export function summarizeFailure(raw: string, maxChars = 160): { summary: string; truncated: boolean } {
  const text = raw.trim();
  const first = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  const summary = first.length > maxChars ? `${first.slice(0, maxChars).trimEnd()}…` : first;
  return { summary, truncated: summary !== text };
}
