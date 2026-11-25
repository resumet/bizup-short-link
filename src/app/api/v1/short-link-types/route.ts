import { apiRoute } from '@/lib/route';
import { handleListShortLinkTypes } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(handleListShortLinkTypes, { read: true });
