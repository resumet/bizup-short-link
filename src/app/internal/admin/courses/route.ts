import { ownerRoute } from '@/lib/route';
import { handleAdminCreateCourse, handleAdminListCourses } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(handleAdminListCourses);
export const POST = ownerRoute(handleAdminCreateCourse);
