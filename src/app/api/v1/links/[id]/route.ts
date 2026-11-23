import { apiRoute } from '@/lib/route';
import { handleGetLink, handlePatchLink } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(handleGetLink, { read: true });
export const PATCH = apiRoute(handlePatchLink);
