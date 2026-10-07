/**
 * 생성 Dockerfile(Dockerfile.b-studio)에 studio.yaml의 `services.<이름>.systemPackages` 선언을 반영한다
 * (도그푸딩 마찰 113). BE-commerce 세션에서 숏폼 변환 측정에 ffmpeg가 필요했는데, 생성 Dockerfile에는
 * 없었고 실행 중 `apt-get update`는 샌드박스 egress 허용 목록(packages/sandbox/src/edge-config.ts)이
 * deb.debian.org·ports.ubuntu.com을 막아 실패했다. 에이전트는 허용된 PyPI에서 `imageio-ffmpeg` 휠을 받아
 * 정적 바이너리를 꺼내 쓰는 우회로를 찾았다 — 시스템 패키지를 선언할 공식 방법이 없었기 때문이다.
 *
 * `docker build`(compose build)는 egress 허용 목록이 적용되는 샌드박스 컨테이너 네트워크가 아니라 호스트
 * Docker 데몬이 보는 네트워크로 돈다(compose의 `networks:`는 런타임 컨테이너에만 적용되고, 빌드 단계의 중간
 * 컨테이너에는 적용되지 않는다 — packages/sandbox/src/docker/compose-provider.ts의 주석 "이미지 빌드 단계에서
 * 받은 것은 컨테이너 NetIO에 잡히지 않는다"가 이미 이 한계를 기록해 뒀다). 그래서 빌드 때 설치하면 런타임
 * 격리를 조금도 느슨하게 하지 않고도 apt-get이 된다(2026-10-08, eclipse-temurin:21-jdk 베이스로 ffmpeg 설치를
 * 실제로 빌드해 확인했다).
 *
 * 선택지 비교(ADR-137):
 *  (a) studio.yaml 선언 → 생성 Dockerfile에 반영 — 사람이 무엇이 설치되는지 보고(diff·Dockerfile 본문),
 *      재시작·재생성 때마다 같은 결과가 나온다(재현 가능), 런타임 격리를 건드리지 않는다. 채택.
 *  (b) egress에 Debian/Ubuntu 미러를 열어 런타임 apt 허용 — 패키지 저장소 접속은 사실상 임의 코드 실행
 *      통로라(이미 PyPI·npm·Maven이 그렇듯) 격리를 넓히는 셈이고, 무엇이 설치됐는지 로그에만 남아 보기 어렵다. 기각.
 *  (c) 사용자가 Dockerfile.b-studio를 직접 고치게 둠(handEdited) — 이미 가능하지만 "생성 파일 다시 만들기"가
 *      손으로 고친 파일로 보고 경고하게 되고, 선언이 아니라 자유 형식이라 사람이 한눈에 "무엇을 설치했는지" 모아 보기 어렵다. 기각(보조 수단으로는 남긴다).
 */

/** 지원하는 베이스 이미지의 패키지 관리자 계열 */
export type PackageFamily = 'apt' | 'apk';

/** 선언한 systemPackages를 설치할 수 없을 때(베이스 이미지 계열을 모름, FROM 줄이 없음, 이름이 유효하지 않음) */
export class SystemPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPackageError';
  }
}

/** apt(Debian·Ubuntu)·apk(Alpine) 패키지 이름. 생성 Dockerfile의 RUN 줄에 그대로 들어가므로 여기서도 다시 검증한다(방어적 중복 검사) */
const SYSTEM_PACKAGE_NAME = /^[a-z0-9][a-z0-9.+-]{0,63}$/;

/** Alpine 계열로 보는 이미지 이름 패턴(명시적으로 alpine을 포함하는 태그) */
const APK_IMAGE = /alpine/i;
/** b-studio가 생성하는 템플릿이 쓰는 Debian·Ubuntu 계열 베이스 이미지 이름(project-detect.ts의 detectNode·detectSpring·detectFastApi 참고) */
const APT_IMAGE = /^(node|python|eclipse-temurin|gradle|maven|debian|ubuntu)(:|$)/i;

/** FROM 줄의 이미지 이름으로 패키지 계열을 가린다. 모르는 계열이면 undefined(조용히 무시하지 않고 호출부가 오류를 낸다) */
export function detectPackageFamily(image: string): PackageFamily | undefined {
  const trimmed = image.trim();
  if (APK_IMAGE.test(trimmed)) return 'apk';
  if (APT_IMAGE.test(trimmed)) return 'apt';
  return undefined;
}

/** Dockerfile 본문에서 FROM 줄의 이미지 이름. 없으면 undefined */
function fromImage(dockerfile: string): string | undefined {
  return /^FROM\s+(\S+)/m.exec(dockerfile)?.[1];
}

const MARKER_BEGIN = '# b-studio: systemPackages(studio.yaml)가 설치를 선언한 패키지';
const MARKER_END = '# b-studio: systemPackages 끝';

function installCommand(family: PackageFamily, packages: readonly string[]): string {
  return family === 'apt'
    ? `RUN apt-get update && apt-get install -y --no-install-recommends ${packages.join(' ')} && rm -rf /var/lib/apt/lists/*`
    : `RUN apk add --no-cache ${packages.join(' ')}`;
}

/** 이전에 applySystemPackages가 넣은 블록(마커 사이)을 지운다. 마커가 없거나 짝이 안 맞으면 그대로 둔다(손상된 상태를 추측해 건드리지 않는다) */
function stripManagedBlock(dockerfile: string): string {
  const lines = dockerfile.split('\n');
  const begin = lines.indexOf(MARKER_BEGIN);
  if (begin === -1) return dockerfile;
  const end = lines.indexOf(MARKER_END, begin);
  if (end === -1) return dockerfile;
  // 삽입할 때 마커 앞에 넣은 구분용 빈 줄도 함께 지운다
  const start = begin > 0 && lines[begin - 1] === '' ? begin - 1 : begin;
  lines.splice(start, end - start + 1);
  return lines.join('\n');
}

/**
 * Dockerfile 본문에 systemPackages 설치 블록을 반영한다. 멱등적이다 — 먼저 이전에 넣은 블록을 지운 뒤
 * 다시 넣으므로, 같은 선언으로 다시 불러도 결과가 같고(재현 가능) 선언을 지우면(`packages: []`) 블록도 사라진다.
 * 베이스 이미지 계열을 모르면 조용히 건너뛰지 않고 SystemPackageError를 던진다. 이름은 다시 한 번 검증한다
 * (studio.yaml 스키마가 이미 막지만, 이 함수가 다른 경로에서도 안전하도록 방어적으로 검사한다)
 */
export function applySystemPackages(dockerfile: string, packages: readonly string[]): string {
  const stripped = stripManagedBlock(dockerfile);
  if (packages.length === 0) return stripped;

  for (const name of packages) {
    if (!SYSTEM_PACKAGE_NAME.test(name)) throw new SystemPackageError(`'${name}'은(는) 올바른 패키지 이름이 아닙니다(영문 소문자·숫자로 시작, 그 뒤 영문 소문자·숫자·.·+·-만 허용)`);
  }

  const image = fromImage(stripped);
  if (!image) throw new SystemPackageError('Dockerfile에 FROM 줄이 없어 systemPackages를 설치할 자리를 찾지 못했습니다');
  const family = detectPackageFamily(image);
  if (!family) {
    throw new SystemPackageError(
      `'${image}' 베이스 이미지의 패키지 계열(apt 또는 apk)을 알 수 없어 systemPackages를 설치할 수 없습니다. ` +
        'Debian·Ubuntu(apt) 또는 Alpine(apk) 계열 이미지만 지원합니다 — 다른 계열이면 Dockerfile.b-studio를 직접 고치세요.',
    );
  }

  const lines = stripped.split('\n');
  const fromIndex = lines.findIndex((line) => /^FROM\s+\S+/.test(line));
  const block = ['', MARKER_BEGIN, installCommand(family, packages), MARKER_END];
  lines.splice(fromIndex + 1, 0, ...block);
  return lines.join('\n');
}
