import { internalRoute } from '@/lib/route';
import { handlePreflight } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const POST = internalRoute(handlePreflight);
