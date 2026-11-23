import { internalRoute } from '@/lib/route';
import { handleListLinks, handleCreateLink } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = internalRoute(handleListLinks);
export const POST = internalRoute(handleCreateLink);
