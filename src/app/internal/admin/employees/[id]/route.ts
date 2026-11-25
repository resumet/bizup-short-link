import { ownerRoute } from '@/lib/route';
import { handleUpdateEmployee } from '@/lib/handlers/admin';

export const dynamic = 'force-dynamic';

export const PATCH = ownerRoute(handleUpdateEmployee);
