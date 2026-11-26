import { supabaseConfigured } from '@/lib/auth/form-route';
import { ConfirmLinkForm } from '@/components/ConfirmLinkForm';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// 이메일 링크(초대·비밀번호 재설정) 확인 화면: 버튼을 눌러야 1회용 토큰을 사용한다 (/auth/confirm 참고)
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!supabaseConfigured()) redirect('/login?error=unavailable');
  const sp = await searchParams;
  return (
    <main className="center">
      <div className="card narrow login-card">
        <h1>BZUP Link</h1>
        <ConfirmLinkForm tokenHash={sp.token_hash ?? null} type={sp.type ?? null} next={sp.next ?? null} />
      </div>
    </main>
  );
}
