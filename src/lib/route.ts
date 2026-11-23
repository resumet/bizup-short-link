import 'server-only';
import { getDb } from '@/lib/db/postgres';
import type { Db } from '@/lib/db/types';
import { errorResponse, newRequestId } from '@/lib/http';
import { authenticateApiKey } from '@/lib/auth/api-key';
import { requireStaff } from '@/lib/auth/staff';
import { requireOwner, type Principal, type UserPrincipal } from '@/lib/auth/principal';
import { consume, limits } from '@/lib/services/ratelimit';
import type { ApiBase } from '@/lib/services/links';

export interface HandlerCtx<P extends Principal = Principal> {
  req: Request;
  db: Db;
  principal: P;
  requestId: string;
  apiBase: ApiBase;
  params: Record<string, string>;
}

type Handler<P extends Principal> = (ctx: HandlerCtx<P>) => Promise<Response>;
type RouteFn = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** 외부 API: 모든 요청에 BZUP Bearer 키 필수 (§13.5) */
export function apiRoute(handler: Handler<Principal>, opts: { read?: boolean } = {}): RouteFn {
  return async (req, { params }) => {
    const requestId = newRequestId();
    try {
      const db = getDb();
      const principal = await authenticateApiKey(db, req.headers.get('authorization'));
      if (opts.read) await consume(db, limits.apiRead(principal));
      return await handler({ req, db, principal, requestId, apiBase: '/api/v1', params: await params });
    } catch (e) {
      return errorResponse(e, requestId);
    }
  };
}

/** 직원 웹 내부 API: Supabase 직원 세션·현재 역할·CSRF (§13.3) */
export function internalRoute(handler: Handler<Principal>): RouteFn {
  return async (req, { params }) => {
    const requestId = newRequestId();
    try {
      const db = getDb();
      const principal = await requireStaff(db, req);
      return await handler({ req, db, principal, requestId, apiBase: '/internal', params: await params });
    } catch (e) {
      return errorResponse(e, requestId);
    }
  };
}

/** 최고관리자 전용 내부 API */
export function ownerRoute(handler: Handler<UserPrincipal>): RouteFn {
  return internalRoute(async (ctx) => {
    requireOwner(ctx.principal);
    return handler(ctx as HandlerCtx<UserPrincipal>);
  });
}

export function methodNotAllowed(allow: string): RouteFn {
  return async () =>
    new Response(null, { status: 405, headers: { Allow: allow, 'Cache-Control': 'no-store' } });
}
