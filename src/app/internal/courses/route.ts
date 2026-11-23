import { internalRoute } from '@/lib/route';
import { handleListCourses } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const GET = internalRoute(handleListCourses);
