import { staffForPage } from '@/lib/auth/page-staff';
import { AccessDenied, TopBar } from '@/components/TopBar';
import { TemplateEditor } from '@/components/TemplateEditor';

export const dynamic = 'force-dynamic';

export default async function TemplatePage() {
  const auth = await staffForPage('/admin/generation-template');
  if (!auth.ok) return <AccessDenied message={auth.message} />;
  const me = auth.principal;
  if (me.role !== 'owner') return <AccessDenied message="최고관리자만 자동생성 이름 목록을 수정할 수 있습니다." />;
  return (
    <div className="page">
      <TopBar me={me} active="template" />
      <main className="content narrow-content">
        <h1>자동생성 이름 목록</h1>
        <TemplateEditor />
      </main>
    </div>
  );
}
