// 로그인 가능 판정 공통 함수 (PRD §3.4)
// 직원 목록의 "로그인 가능" 표시와 실제 보호된 요청의 접근 판정이 같은 함수를 사용한다.

export interface AuthUserState {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  banned_until: string | null;
  last_sign_in_at: string | null;
}

export interface MemberState {
  role: 'owner' | 'editor' | 'viewer';
  status: 'invited' | 'onboarding' | 'active' | 'suspended';
}

export type AccessReason =
  | 'ok'
  | 'auth_unavailable'
  | 'no_auth_account'
  | 'email_unconfirmed'
  | 'auth_banned'
  | 'not_member'
  | 'invitation_pending'
  | 'onboarding_incomplete'
  | 'suspended';

export interface AccessDecision {
  canLogin: 'yes' | 'no' | 'unknown';
  reason: AccessReason;
}

export const ACCESS_REASON_LABEL: Record<AccessReason, string> = {
  ok: '',
  auth_unavailable: '로그인 가능 여부를 확인할 수 없습니다',
  no_auth_account: '연결된 로그인 계정 없음',
  email_unconfirmed: '이메일 확인 미완료',
  auth_banned: 'Auth 차단',
  not_member: '이 서비스의 직원으로 등록되지 않았습니다',
  invitation_pending: '초대 미수락',
  onboarding_incomplete: '초기 설정 미완료',
  suspended: '접근 중지',
};

/**
 * @param auth Auth 조회 결과. 'error' 는 조회 실패(추측하지 않음), null 은 계정 없음·삭제.
 */
export function evaluateAccess(auth: AuthUserState | null | 'error', member: MemberState | null, now = new Date()): AccessDecision {
  if (auth === 'error') return { canLogin: 'unknown', reason: 'auth_unavailable' };
  if (!auth) return { canLogin: 'no', reason: 'no_auth_account' };
  if (auth.banned_until && new Date(auth.banned_until) > now) return { canLogin: 'no', reason: 'auth_banned' };
  if (!member) return { canLogin: 'no', reason: 'not_member' };
  if (member.status === 'suspended') return { canLogin: 'no', reason: 'suspended' };
  if (member.status === 'invited') return { canLogin: 'no', reason: 'invitation_pending' };
  if (member.status === 'onboarding') return { canLogin: 'no', reason: 'onboarding_incomplete' };
  if (!auth.email_confirmed_at) return { canLogin: 'no', reason: 'email_unconfirmed' };
  return { canLogin: 'yes', reason: 'ok' };
}
