import { internalRoute } from '@/lib/route';
import { handleRevisions } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = internalRoute(handleRevisions);
