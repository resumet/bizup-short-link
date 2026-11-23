import { internalRoute } from '@/lib/route';
import { handleCreateBatch } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const POST = internalRoute(handleCreateBatch);
