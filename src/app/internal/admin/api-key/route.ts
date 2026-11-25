import { ownerRoute } from '@/lib/route';
import { handleApiKeyStatus } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(handleApiKeyStatus);
