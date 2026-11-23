import { ownerRoute } from '@/lib/route';
import { handleApiKeyIssue } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const POST = ownerRoute(handleApiKeyIssue);
