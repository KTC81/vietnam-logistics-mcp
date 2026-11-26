/**
 * Lỗi hai tầng thông điệp:
 * - `messageVi`: tiếng Việt, trả cho người dùng cuối trong kết quả tool;
 * - `messageEn`: tiếng Anh, CHỈ dùng cho log đã lọc của dev, không trả cho AI/người dùng.
 *
 * Thông điệp và chính sách thử lại được khai báo tập trung trong danh mục bên dưới.
 */
import type { ToolErrorInfo, ToolFailure, ValidationIssue } from './types.js';

/** Mã lỗi nội bộ. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONFIG_MISSING'
  | 'GHN_UNAUTHORIZED'
  | 'GHN_RATE_LIMITED'
  | 'GHN_SERVER_ERROR'
  | 'GHN_TIMEOUT'
  | 'GHN_NETWORK'
  | 'GHN_ORDER_NOT_FOUND'
  | 'GHN_BAD_REQUEST'
  | 'GHN_UNEXPECTED_RESPONSE'
  | 'INTERNAL_ERROR';

/**
 * Chính sách thử lại:
 * - `auto`: server tự thử lại đúng 1 lần;
 * - `user`: server không tự thử, người dùng/AI có thể thử lại sau;
 * - `no`: phải sửa dữ liệu hoặc cấu hình.
 */
export type Retryable = 'auto' | 'user' | 'no';

/** Một mục trong danh mục mã lỗi. */
export interface ErrorCatalogEntry {
  /** Thông điệp tiếng Việt, có thể chứa biến dạng `{tên}` để `createAppError` điền. */
  readonly messageVi: string;
  /** Thông điệp tiếng Anh cho log của dev. */
  readonly messageEn: string;
  readonly retry: Retryable;
}

/**
 * Danh mục mã lỗi. Thông điệp tiếng Việt/Anh và chính sách thử lại được khai báo tại đây.
 */
export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = {
  VALIDATION_ERROR: {
    messageVi: 'Dữ liệu nhập chưa đúng: {trường}: {lý do}. Vui lòng sửa rồi thử lại.',
    messageEn: 'Input validation failed: {fields}',
    retry: 'no',
  },
  CONFIG_MISSING: {
    messageVi: 'Thiếu cấu hình {tên biến}. Hãy điền trong cấu hình AI client rồi khởi động lại.',
    messageEn: 'Missing required configuration: {name}',
    retry: 'no',
  },
  GHN_UNAUTHORIZED: {
    messageVi: 'Token GHN hết hạn, lấy token mới tại khachhang.ghn.vn',
    messageEn: 'GHN returned 401: token invalid or expired',
    retry: 'no',
  },
  GHN_RATE_LIMITED: {
    messageVi: 'GHN đang giới hạn tần suất truy cập. Vui lòng thử lại sau ít phút.',
    messageEn: 'GHN returned 429: rate limited',
    retry: 'user',
  },
  GHN_SERVER_ERROR: {
    messageVi: 'GHN đang gặp sự cố. Vui lòng thử lại sau.',
    messageEn: 'GHN returned 5xx after 1 retry',
    // "auto, rồi user": tự thử lại lần đầu, người dùng vẫn thử lại được.
    retry: 'auto',
  },
  GHN_TIMEOUT: {
    messageVi: 'GHN phản hồi quá chậm. Vui lòng thử lại.',
    messageEn: 'Request to GHN timed out after {ms} ms',
    // Tool đọc dùng 'auto'.
    retry: 'auto',
  },
  GHN_NETWORK: {
    messageVi: 'Không kết nối được tới GHN. Kiểm tra mạng rồi thử lại.',
    messageEn: 'Network error reaching GHN: {errno}',
    retry: 'user',
  },
  GHN_ORDER_NOT_FOUND: {
    messageVi: 'Không tìm thấy đơn {order_code}. Hãy kiểm tra lại mã vận đơn.',
    messageEn: 'Order not found on GHN',
    retry: 'no',
  },
  GHN_BAD_REQUEST: {
    messageVi:
      'GHN từ chối yêu cầu vì dữ liệu chưa hợp lệ. Hãy kiểm tra lại thông tin đơn/địa chỉ.',
    messageEn: 'GHN rejected request: http {status}, code {code}',
    retry: 'no',
  },
  GHN_UNEXPECTED_RESPONSE: {
    messageVi:
      'Dữ liệu GHN trả về không đúng định dạng. Vui lòng báo hỗ trợ kèm mã yêu cầu {requestId}.',
    messageEn: 'GHN response failed schema validation: {path}',
    retry: 'no',
  },
  INTERNAL_ERROR: {
    messageVi:
      'Có lỗi nội bộ. Vui lòng thử lại; nếu lặp lại hãy báo hỗ trợ kèm mã yêu cầu {requestId}.',
    messageEn: 'Unhandled internal error',
    retry: 'user',
  },
};

/**
 * Giá trị thay vào các biến `{tên}` trong thông điệp của danh mục.
 *
 * Lưu ý: KHÔNG đưa SĐT hay địa chỉ khách vào params; `messageEn` (đã điền giá trị)
 * được ghi vào log của dev, nên chỉ truyền dữ liệu kỹ thuật như `path`, `order_code`, `errno`.
 */
export type MessageParams = Readonly<Record<string, string | number>>;

/** Mã yêu cầu của một lời gọi tool, dạng chuỗi (ví dụ `req_7f3a9c`). */
export type RequestId = string;

/** Tham số phụ khi dựng `AppError`. */
export interface CreateAppErrorOptions {
  /** Chỉ dùng cho `VALIDATION_ERROR`. */
  issues?: readonly ValidationIssue[];
  /** Lỗi gốc; chỉ vào log đã lọc, KHÔNG bao giờ vào thông điệp người dùng. */
  cause?: unknown;
  /**
   * Mã yêu cầu của lời gọi, dùng khi `params.requestId` không có.
   * Đây là khóa HỆ THỐNG: thiếu (hoặc chuỗi rỗng) cũng không ném lỗi (xem createAppError).
   */
  requestId?: RequestId;
}

/** Tham số khởi tạo của `AppError` (dùng khi cần dựng trực tiếp trong test). */
export interface AppErrorInit {
  code: ErrorCode;
  messageVi: string;
  messageEn: string;
  retry: Retryable;
  issues?: readonly ValidationIssue[];
  cause?: unknown;
  /** true khi thông điệp phải dùng mã yêu cầu dự phòng (lúc dựng chưa biết requestId thật). */
  requestIdPending?: boolean;
  /** Tham số gốc đã dùng để điền thông điệp; giữ nội bộ để dựng lại khi biết requestId. */
  params?: MessageParams;
}

/**
 * Lỗi có cấu trúc của lõi.
 *
 * `error.message` của lớp này là `messageEn` (tầng dev). Tầng người dùng là `messageVi`,
 * được đặt vào kết quả tool qua `toToolErrorResult`. Không để stack, đường dẫn máy,
 * token hay thân phản hồi GHN thô vào `messageVi`.
 *
 * `requestIdPending = true` nghĩa là lúc dựng chưa biết mã yêu cầu nên thông điệp đang mang
 * dấu dự phòng; `toToolErrorResult` sẽ dựng lại bằng mã thật. Thuộc tính này và params gốc
 * KHÔNG được đưa ra kết quả tool.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly messageVi: string;
  readonly messageEn: string;
  readonly retry: Retryable;
  readonly issues?: readonly ValidationIssue[];
  readonly requestIdPending: boolean;
  // Tham số gốc để dựng lại thông điệp; trường riêng tư nên không lộ khi in hay trả kết quả.
  readonly #params: MessageParams;

  constructor(init: AppErrorInit) {
    super(init.messageEn, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AppError';
    this.code = init.code;
    this.messageVi = init.messageVi;
    this.messageEn = init.messageEn;
    this.retry = init.retry;
    this.issues = init.issues;
    this.requestIdPending = init.requestIdPending ?? false;
    this.#params = init.params ?? {};
  }

  /** `true` khi còn đường thử lại: server tự thử (`auto`) hoặc người dùng thử sau (`user`). */
  get retryable(): boolean {
    return this.retry !== 'no';
  }

  /**
   * Dựng lại lỗi với mã yêu cầu thật khi lúc đầu chưa biết (`requestIdPending`).
   *
   * Dùng lại params gốc nên mã còn placeholder khác ngoài `requestId` (ví dụ `{path}` của
   * `GHN_UNEXPECTED_RESPONSE`) vẫn dựng lại được — không phải vì danh mục chỉ có `requestId`.
   * Bản mới giữ `stack` của bản gốc để log trỏ đúng nơi phát sinh lỗi.
   */
  withRequestId(requestId: RequestId): AppError {
    const rebuilt = createAppError(
      this.code,
      { ...this.#params, requestId },
      { issues: this.issues, cause: this.cause },
    );
    // Bản dựng lại là object mới nên stack sẽ trỏ về toToolErrorResult; gán lại stack gốc.
    rebuilt.stack = this.stack;
    return rebuilt;
  }
}

// Mẫu biến trong thông điệp danh mục, ví dụ `{order_code}` hoặc `{tên biến}`.
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

// Liệt kê tên biến có trong một mẫu thông điệp.
function listPlaceholderNames(template: string): string[] {
  return Array.from(template.matchAll(PLACEHOLDER_PATTERN), (match) => match[1]);
}

// Điền các biến `{tên}` bằng giá trị trong `params`.
// Chỉ gọi sau khi đã kiểm đủ tham số (xem createAppError).
function fillPlaceholders(template: string, params: MessageParams): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

// Khóa hệ thống cho mã yêu cầu trong thông điệp danh mục.
const REQUEST_ID_KEY = 'requestId';
// Dấu dự phòng khi lỗi được dựng trước khi biết requestId thật.
// Lưu ý: nếu nơi đọc `messageVi` trực tiếp mà KHÔNG qua toToolErrorResult, người dùng có thể
// thấy chuỗi này; luôn trả kết quả tool qua toToolErrorResult.
const FALLBACK_REQUEST_ID = 'req_unknown';

// Chuẩn hoá một giá trị mã yêu cầu: chỉ nhận chuỗi khác rỗng sau khi cắt khoảng trắng;
// rỗng, toàn khoảng trắng hoặc sai kiểu (ví dụ số) được coi là THIẾU.
function normalizeRequestId(value: unknown): RequestId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// Ưu tiên requestId trong params, rồi tới options; trả undefined khi cả hai đều thiếu/không hợp lệ.
function pickRequestId(params: MessageParams, fromOptions?: RequestId): RequestId | undefined {
  return normalizeRequestId(params[REQUEST_ID_KEY]) ?? normalizeRequestId(fromOptions);
}

/**
 * Dựng `AppError` từ danh mục, điền biến vào thông điệp.
 *
 * Chỉ nhận `code` và các giá trị thay biến, KHÔNG nhận thông điệp thô từ ngoài:
 * nhờ vậy lỗi GHN/Zod thô không thể lọt vào `messageVi`.
 *
 * `requestId` là KHÓA HỆ THỐNG: lấy theo thứ tự `params.requestId`, `options.requestId`,
 * rồi dấu dự phòng `req_unknown`. Giá trị rỗng/toàn khoảng trắng hoặc không phải chuỗi
 * đều coi là thiếu. Thiếu nó KHÔNG ném lỗi, vì tầng gateway có thể dựng
 * `GHN_UNEXPECTED_RESPONSE`/`INTERNAL_ERROR` trước khi biết mã yêu cầu; khi đó
 * `requestIdPending = true` và `toToolErrorResult` sẽ dựng lại bằng mã thật.
 *
 * Mã còn placeholder khác ngoài `requestId` vẫn dựng lại được nhờ params gốc lưu nội bộ
 * trên `AppError` — không phải vì danh mục chỉ có `requestId`.
 *
 * Các placeholder KHÁC thiếu vẫn là lỗi LẬP TRÌNH: ném `Error` ngay để không lọt `{…}`
 * tới người dùng. Kiểm trên MẪU (trước khi thay) chứ không kiểm trên chuỗi kết quả,
 * nên một tham số hợp lệ chứa chuỗi `{requestId}` vẫn được giữ nguyên.
 */
export function createAppError(
  code: ErrorCode,
  params: MessageParams = {},
  options: CreateAppErrorOptions = {},
): AppError {
  const entry = ERROR_CATALOG[code];
  const placeholderNames = [
    ...new Set([
      ...listPlaceholderNames(entry.messageVi),
      ...listPlaceholderNames(entry.messageEn),
    ]),
  ];
  const usesRequestId = placeholderNames.includes(REQUEST_ID_KEY);

  const providedRequestId = pickRequestId(params, options.requestId);
  const requestId = providedRequestId ?? FALLBACK_REQUEST_ID;
  const requestIdPending = usesRequestId && providedRequestId === undefined;

  const missing = placeholderNames.filter(
    (name) => name !== REQUEST_ID_KEY && params[name] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(`createAppError: missing placeholders for ${code}: ${missing.join(', ')}`);
  }

  // Điền requestId đã phân giải (params > options > dự phòng); params gốc được giữ nguyên
  // trên AppError để dựng lại khi biết mã thật.
  const filledParams: MessageParams = { ...params, [REQUEST_ID_KEY]: requestId };
  return new AppError({
    code,
    messageVi: fillPlaceholders(entry.messageVi, filledParams),
    messageEn: fillPlaceholders(entry.messageEn, filledParams),
    retry: entry.retry,
    issues: options.issues,
    cause: options.cause,
    requestIdPending,
    params,
  });
}

/** Kiểm tra một giá trị có phải `AppError` (dùng trong pipeline bắt lỗi). */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Chuẩn hoá mọi lỗi thành `AppError`.
 * Lỗi lạ chuyển thành `INTERNAL_ERROR` (messageVi chung chung); lỗi gốc giữ ở `cause`
 * để logger ghi vào log đã lọc, không đưa vào kết quả tool.
 *
 * `requestId` truyền qua `options.requestId` (không phải params). Không có, rỗng hoặc toàn
 * khoảng trắng thì thông điệp dùng dấu dự phòng `req_unknown` và `requestIdPending = true`;
 * `toToolErrorResult` sẽ dựng lại bằng mã thật. Đọc thẳng `messageVi` ở chỗ khác có thể
 * làm lộ `req_unknown` ra người dùng.
 */
export function toAppError(error: unknown, requestId?: RequestId): AppError {
  if (isAppError(error)) {
    return error;
  }
  return createAppError('INTERNAL_ERROR', {}, { requestId, cause: error });
}

/**
 * Dựng kết quả lỗi đúng dạng:
 * `{ ok: false, error: { code, message, retryable, issues? }, meta: { requestId } }`.
 *
 * `requestId` được chuẩn hoá MỘT lần ở đầu hàm (rỗng/toàn khoảng trắng/sai kiểu →
 * `req_unknown`) rồi dùng cho cả thông điệp lẫn `meta.requestId`, để hai nơi không lệch nhau.
 *
 * Nếu lỗi được dựng trước khi biết mã yêu cầu (`requestIdPending`), dựng lại ĐÚNG MỘT LẦN
 * bằng mã đã chuẩn hoá và params gốc. Lỗi không pending giữ nguyên `messageVi` (không thay biến
 * lần hai, để tham số người dùng chứa chuỗi `{requestId}` không bị thay nhầm).
 * Không trả `messageEn`, `requestIdPending`, params gốc, stack hay lỗi gốc.
 */
export function toToolErrorResult(error: unknown, requestId: RequestId): ToolFailure {
  const normalizedRequestId = normalizeRequestId(requestId) ?? FALLBACK_REQUEST_ID;
  const appError = toAppError(error, normalizedRequestId);
  const resolved = appError.requestIdPending
    ? appError.withRequestId(normalizedRequestId)
    : appError;
  const errorInfo: ToolErrorInfo = {
    code: resolved.code,
    message: resolved.messageVi,
    retryable: resolved.retryable,
  };
  if (resolved.code === 'VALIDATION_ERROR' && resolved.issues !== undefined) {
    errorInfo.issues = resolved.issues.map((issue) => ({
      field: issue.field,
      message: issue.message,
    }));
  }
  return { ok: false, error: errorInfo, meta: { requestId: normalizedRequestId } };
}
