import { ownerRoute } from '@/lib/route';
import { handleAdminListCourses } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(handleAdminListCourses);
