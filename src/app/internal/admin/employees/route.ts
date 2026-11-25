import { ownerRoute } from '@/lib/route';
import { handleInviteEmployee, handleListEmployees } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(handleListEmployees);
export const POST = ownerRoute(handleInviteEmployee);
