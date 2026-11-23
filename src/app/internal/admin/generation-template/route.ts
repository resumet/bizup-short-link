import { ownerRoute } from '@/lib/route';
import { handleAdminGetTemplate, handleAdminSaveTemplate } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(handleAdminGetTemplate);
export const PUT = ownerRoute(handleAdminSaveTemplate);
