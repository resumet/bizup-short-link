import { internalRoute } from '@/lib/route';
import { handleGetLink, handlePatchLink } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = internalRoute(handleGetLink);
export const PATCH = internalRoute(handlePatchLink);
