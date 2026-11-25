import { internalRoute } from '@/lib/route';
import { handleDeleteLink, handleGetLink, handlePatchLink } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = internalRoute(handleGetLink);
export const PATCH = internalRoute(handlePatchLink);
export const DELETE = internalRoute(handleDeleteLink);
