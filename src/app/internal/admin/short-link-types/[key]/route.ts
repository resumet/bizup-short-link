import { ownerRoute } from '@/lib/route';
import { handleDeleteLinkType, handleUpdateLinkType } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const PATCH = ownerRoute(handleUpdateLinkType);
export const DELETE = ownerRoute(handleDeleteLinkType);
