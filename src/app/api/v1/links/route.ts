import { apiRoute } from '@/lib/route';
import { handleListLinks, handleCreateLink } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(handleListLinks, { read: true });
export const POST = apiRoute(handleCreateLink);
