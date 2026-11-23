import { internalRoute } from '@/lib/route';
import { handleViews } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

// 일자별(KST) 조회수와 총조회수. ?days=1~366 (기본 30)
export const GET = internalRoute(handleViews);
