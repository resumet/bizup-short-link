import { apiRoute } from '@/lib/route';
import { handleRevisions } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(handleRevisions, { read: true });
