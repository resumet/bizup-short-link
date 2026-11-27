// 전환형 짧은 주소 전환 (links:update): { course_id, type_key, slot }
import { apiRoute } from '@/lib/route';
import { handleTypedSwitch } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(handleTypedSwitch);
