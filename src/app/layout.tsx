import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BZUP Link',
  description: '짧은 주소·강의별 링크 관리',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
