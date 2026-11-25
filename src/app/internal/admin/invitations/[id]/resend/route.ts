import { ownerRoute } from '@/lib/route';
import { handleResendInvitation } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const POST = ownerRoute(handleResendInvitation);
