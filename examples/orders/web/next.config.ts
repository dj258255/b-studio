import type { NextConfig } from "next";

const apiBaseUrl = process.env.API_BASE_URL;

const nextConfig: NextConfig = {
  // 백엔드 서비스가 있으면 /api 요청을 넘겨서, 브라우저가 CORS 없이 같은 origin으로 호출하게 한다
  async rewrites() {
    return apiBaseUrl ? [{ source: "/api/:path*", destination: `${apiBaseUrl}/api/:path*` }] : [];
  },
};

export default nextConfig;
