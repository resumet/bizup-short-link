import { ownerRoute } from '@/lib/route';
import { handleAdminUpdateCourse } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const PATCH = ownerRoute(handleAdminUpdateCourse);
