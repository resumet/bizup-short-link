import { apiRoute } from '@/lib/route';
import { handleGetTemplate } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(handleGetTemplate, { read: true });
