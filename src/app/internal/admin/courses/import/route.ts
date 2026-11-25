import { ownerRoute } from '@/lib/route';
import { handleAdminImportCourses } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const POST = ownerRoute(handleAdminImportCourses);
