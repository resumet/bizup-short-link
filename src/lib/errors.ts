// 공통 오류 (PRD §14.8)

export type ErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_CURSOR'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_IF_MATCH'
  | 'UNAUTHENTICATED'
  | 'INVALID_API_KEY'
  | 'INSUFFICIENT_SCOPE'
  | 'ACCESS_SUSPENDED'
  | 'INSUFFICIENT_PERMISSION'
  | 'CSRF_REJECTED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'DUPLICATE_DESTINATION'
  | 'DUPLICATE_REVIEW_CHANGED'
  | 'REVIEW_EXPIRED'
  | 'REVIEW_MISMATCH'
  | 'REVIEW_ALREADY_USED'
  | 'TEMPLATE_CHANGED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'EXTERNAL_REF_EXISTS'
  | 'LAST_OWNER_REQUIRED'
  | 'EMPLOYEE_EXISTS'
  | 'LINK_TYPE_EXISTS'
  | 'UNKNOWN_LINK_TYPE'
  | 'LINK_TYPE_INACTIVE'
  | 'INVITE_DELIVERY_FAILED'
  | 'API_KEY_LIMIT_EXCEEDED'
  | 'API_KEY_STATE_CONFLICT'
  | 'API_CLIENT_STATE_CONFLICT'
  | 'ROTATION_ALREADY_SCHEDULED'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VALIDATION_ERROR'
  | 'INVALID_SCOPES'
  | 'SCOPE_EXPANSION_NOT_ALLOWED'
  | 'INVALID_EXPIRATION'
  | 'COURSE_REQUIRED'
  | 'COURSE_NOT_ACTIVE'
  | 'TEMPLATE_EMPTY'
  | 'TEMPLATE_ITEMS_MISMATCH'
  | 'INVALID_DESTINATION_URL'
  | 'FORBIDDEN_DESTINATION'
  | 'EMPTY_EXPORT'
  | 'EXPORT_LIMIT_EXCEEDED'
  | 'PRECONDITION_REQUIRED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  INVALID_CURSOR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  INVALID_IF_MATCH: 400,
  UNAUTHENTICATED: 401,
  INVALID_API_KEY: 401,
  INSUFFICIENT_SCOPE: 403,
  ACCESS_SUSPENDED: 403,
  INSUFFICIENT_PERMISSION: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  DUPLICATE_DESTINATION: 409,
  DUPLICATE_REVIEW_CHANGED: 409,
  REVIEW_EXPIRED: 409,
  REVIEW_MISMATCH: 409,
  REVIEW_ALREADY_USED: 409,
  TEMPLATE_CHANGED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  EXTERNAL_REF_EXISTS: 409,
  LAST_OWNER_REQUIRED: 409,
  EMPLOYEE_EXISTS: 409,
  LINK_TYPE_EXISTS: 409,
  UNKNOWN_LINK_TYPE: 422,
  LINK_TYPE_INACTIVE: 422,
  INVITE_DELIVERY_FAILED: 502,
  API_KEY_LIMIT_EXCEEDED: 409,
  API_KEY_STATE_CONFLICT: 409,
  API_CLIENT_STATE_CONFLICT: 409,
  ROTATION_ALREADY_SCHEDULED: 409,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_ERROR: 422,
  INVALID_SCOPES: 422,
  SCOPE_EXPANSION_NOT_ALLOWED: 422,
  INVALID_EXPIRATION: 422,
  COURSE_REQUIRED: 422,
  COURSE_NOT_ACTIVE: 422,
  TEMPLATE_EMPTY: 422,
  TEMPLATE_ITEMS_MISMATCH: 422,
  INVALID_DESTINATION_URL: 422,
  FORBIDDEN_DESTINATION: 422,
  EMPTY_EXPORT: 422,
  EXPORT_LIMIT_EXCEEDED: 422,
  PRECONDITION_REQUIRED: 428,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

const DEFAULT_MESSAGE: Partial<Record<ErrorCode, string>> = {
  INVALID_API_KEY: '유효한 API 키가 필요합니다.',
  UNAUTHENTICATED: '로그인이 필요합니다.',
  ACCESS_SUSPENDED: '서비스 접근이 중지되었습니다.',
  INSUFFICIENT_PERMISSION: '이 작업을 수행할 권한이 없습니다.',
  INSUFFICIENT_SCOPE: '이 API 키에는 해당 작업 권한이 없습니다.',
  NOT_FOUND: '대상을 찾을 수 없습니다.',
  PRECONDITION_FAILED: '다른 작업자가 먼저 변경했습니다. 최신 내용을 확인해 주세요.',
  PRECONDITION_REQUIRED: 'If-Match 헤더가 필요합니다.',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key 헤더가 필요합니다.',
  IDEMPOTENCY_IN_PROGRESS: '같은 요청을 처리하고 있습니다. 잠시 후 같은 내용으로 다시 시도해 주세요.',
  IDEMPOTENCY_KEY_REUSED: '같은 Idempotency-Key로 다른 내용의 요청을 보낼 수 없습니다.',
  DUPLICATE_DESTINATION: '같은 연결 주소를 사용하는 새 짧은 주소를 만들까요?',
  DUPLICATE_REVIEW_CHANGED: '같은 연결 주소의 링크 구성이 바뀌었습니다. 다시 확인해 주세요.',
  REVIEW_EXPIRED: '중복 확인 시간이 지났습니다. 다시 확인해 주세요.',
  REVIEW_MISMATCH: '확인한 내용과 요청 내용이 다릅니다. 다시 확인해 주세요.',
  REVIEW_ALREADY_USED: '이미 사용한 중복 확인입니다. 다시 확인해 주세요.',
  TEMPLATE_CHANGED: '이름 목록이 변경되었습니다. 입력값을 확인한 뒤 다시 진행해 주세요.',
  TEMPLATE_EMPTY: '자동생성할 이름 목록을 먼저 등록해 주세요.',
  COURSE_REQUIRED: '강의를 선택해 주세요.',
  COURSE_NOT_ACTIVE: '진행중인 강의만 선택할 수 있습니다.',
  EMPTY_EXPORT: '내려받을 항목이 없습니다.',
  EXPORT_LIMIT_EXCEEDED: '강의 또는 기간을 좁혀 다시 내려받아 주세요.',
  RATE_LIMITED: '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
  SERVICE_UNAVAILABLE: '일시적으로 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  INTERNAL_ERROR: '예상하지 못한 오류가 발생했습니다.',
  LAST_OWNER_REQUIRED: '마지막 최고관리자는 중지하거나 강등할 수 없습니다.',
  PAYLOAD_TOO_LARGE: '요청 본문이 너무 큽니다.',
  UNSUPPORTED_MEDIA_TYPE: 'JSON 형식으로 요청해 주세요.',
  INVALID_JSON: '요청 본문이 올바른 JSON이 아닙니다.',
  INVALID_IF_MATCH: 'If-Match 형식이 올바르지 않습니다.',
  CSRF_REJECTED: '요청 출처를 확인할 수 없습니다.',
  EMPLOYEE_EXISTS: '이미 등록된 직원입니다.',
  LINK_TYPE_EXISTS: '이 강의에는 같은 유형의 짧은 주소가 이미 있습니다.',
  UNKNOWN_LINK_TYPE: '등록되지 않은 type_key 입니다. /api/v1/short-link-types 에서 확인해 주세요.',
  LINK_TYPE_INACTIVE: '비활성 유형이라 새 짧은 주소를 만들 수 없습니다.',
  INVITE_DELIVERY_FAILED: '초대 메일 발송 요청이 실패했습니다. 잠시 후 다시 시도해 주세요.',
};

export interface RowError {
  row?: number;
  template_item_id?: string;
  field?: string;
  message: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly rowErrors?: RowError[];
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message?: string,
    opts: {
      status?: number;
      details?: Record<string, unknown>;
      rowErrors?: RowError[];
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message ?? DEFAULT_MESSAGE[code] ?? code);
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code];
    this.details = opts.details;
    this.rowErrors = opts.rowErrors;
    this.headers = opts.headers;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

export function validationError(message: string, rowErrors?: RowError[], details?: Record<string, unknown>) {
  return new AppError('VALIDATION_ERROR', message, { rowErrors, details });
}
