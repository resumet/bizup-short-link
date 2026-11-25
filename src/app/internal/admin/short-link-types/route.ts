import { ownerRoute } from '@/lib/route';
import { handleCreateLinkType, handleListLinkTypes } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(handleListLinkTypes);
export const POST = ownerRoute(handleCreateLinkType);
