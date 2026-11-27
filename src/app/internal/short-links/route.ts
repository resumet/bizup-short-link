// 직원 웹: 유형(type_key)으로 짧은 주소 만들기 (전환형 유형은 slot_urls). 외부 API POST /api/v1/short-links 와 같은 규칙
import { internalRoute } from '@/lib/route';
import { handleSimpleCreate } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const POST = internalRoute(handleSimpleCreate);
