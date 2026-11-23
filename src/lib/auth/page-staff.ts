import 'server-only';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db/postgres';
import { AppError } from '@/lib/errors';
import { requireStaff } from './staff';
import type { UserPrincipal } from './principal';

export type StaffPageResult =
  | { ok: true; principal: UserPrincipal }
  | { ok: false; code: string; message: string };

/** 서버 컴포넌트용: 미로그인은 /login 으로, 그 외 거절 사유는 화면에 표시 (§21) */
export async function staffForPage(nextPath: string): Promise<StaffPageResult> {
  try {
    return { ok: true, principal: await requireStaff(getDb()) };
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === 'UNAUTHENTICATED') redirect(`/login?next=${encodeURIComponent(nextPath)}`);
      return { ok: false, code: e.code, message: e.message };
    }
    throw e;
  }
}
