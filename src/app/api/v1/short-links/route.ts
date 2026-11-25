// 간단 생성 API: 강의 UUID·목적지 주소·명칭 → 짧은 주소
// - Authorization: Bearer 시스템 API 키 (links:create) 필수
// - 같은 목적지가 이미 있어도 확인 단계 없이 새로 만든다 (중복 확인 토큰을 서버가 이어서 사용)
// - Idempotency-Key 헤더는 선택. 보내면 재시도 시 같은 결과를 돌려준다
import { apiRoute } from '@/lib/route';
import { handleSimpleCreate } from '@/lib/handlers/links';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(handleSimpleCreate);
