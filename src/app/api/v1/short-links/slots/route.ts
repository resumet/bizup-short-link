// 전환형 짧은 주소의 전환 주소 채우기·바꾸기·비우기 (links:update)
// { course_id, type_key, slot, destination_url: URL | null, activate?: boolean }
import { apiRoute } from '@/lib/route';
import { handleTypedSetSlot } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const PUT = apiRoute(handleTypedSetSlot);
