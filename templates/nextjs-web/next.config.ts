import type { NextConfig } from "next";

const apiBaseUrl = process.env.API_BASE_URL;

const nextConfig: NextConfig = {
  // 스튜디오 미리보기는 dev 서버가 시작된 호스트(0.0.0.0)가 아니라 127.0.0.1의 다른 포트로 접속한다.
  // 개발용 요청(HMR 연결 등)이 교차 출처로 막히지 않게 허용한다
  allowedDevOrigins: ["127.0.0.1"],
  // 백엔드 서비스가 있으면 /api 요청을 넘겨서, 브라우저가 CORS 없이 같은 origin으로 호출하게 한다
  async rewrites() {
    return apiBaseUrl ? [{ source: "/api/:path*", destination: `${apiBaseUrl}/api/:path*` }] : [];
  },
};

export default nextConfig;
