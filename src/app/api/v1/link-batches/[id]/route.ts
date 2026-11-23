import { apiRoute } from '@/lib/route';
import { handleGetBatch } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(handleGetBatch, { read: true });
