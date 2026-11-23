import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 코드 뒤 단일 / 는 미들웨어에서 같은 코드로 처리한다 (308 자동 이동 금지)
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  serverExternalPackages: ['postgres', 'exceljs'],
  async headers() {
    return [
      {
        // 공개 짧은 주소 응답 헤더(Referrer-Policy: no-referrer 등)는 라우트가 직접 정한다
        source: '/:dir(links|admin|login|auth|account)/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
