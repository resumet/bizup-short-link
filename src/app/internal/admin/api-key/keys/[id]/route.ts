import { ownerRoute } from '@/lib/route';
import { handleApiKeyRevoke } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const DELETE = ownerRoute(handleApiKeyRevoke);
