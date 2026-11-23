import { internalRoute } from '@/lib/route';
import { handleGetBatch } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = internalRoute(handleGetBatch);
