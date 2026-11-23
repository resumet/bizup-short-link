import { ownerRoute } from '@/lib/route';
import { handleApiKeySettings, handleApiKeyStatus } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(handleApiKeyStatus);
export const PATCH = ownerRoute(handleApiKeySettings);
