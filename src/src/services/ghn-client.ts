/**
 * Cổng DUY NHẤT gọi API GHN.
 *
 * Client lo: kiểm thông tin đăng nhập, dựng URL/header theo môi trường, chọn GET/POST theo
 * endpoint, timeout, thử lại, đọc phản hồi, kiểm phần `data` bằng `responseSchema`, và ánh xạ
 * MỌI lỗi sang `AppError`.
 *
 * RÀNG BUỘC BẢO MẬT: KHÔNG BAO GIỜ đưa `message`/`code_message` thô của GHN, thân phản hồi,
 * header, URL đầy đủ, token hay ShopId vào `AppError`, kết quả tool hoặc log. Lỗi GHN như
 * `SHOP_INFO_ERROR` có thể chứa mã shop và số điện thoại trong `message`.
 * Vì vậy KHÔNG gắn lỗi fetch thô làm `cause` (undici có thể nêu nguyên giá trị header/token).
 */
import type { ZodType } from 'zod';
import { createAppError, toAppError } from '../core/errors.js';
import type {
  CredentialProvider,
  GhnCredentials,
  GhnEndpoint,
  GhnEnvironment,
  GhnGateway,
  ToolLogger,
} from '../core/types.js';
import { getBaseUrl } from '../config/env.js';

// Thời gian chờ mặc định cho mỗi lần gọi và mỗi lần thử lại.
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_RETRY_DELAY_MS = 300;
// Một lần gọi + đúng 1 lần thử lại. 401/429/lỗi mạng/4xx không thử lại.
const MAX_ATTEMPTS = 2;

/** Phương thức HTTP theo endpoint. */
type HttpMethod = 'GET' | 'POST';

// detail và shop/all là GET, fee và available-services là POST.
// Tool không cần biết phương thức.
const ENDPOINT_METHODS: Readonly<Record<GhnEndpoint, HttpMethod>> = {
  '/v2/shipping-order/detail': 'GET',
  '/v2/shop/all': 'GET',
  '/v2/shipping-order/fee': 'POST',
  '/v2/shipping-order/available-services': 'POST',
};

const ORDER_DETAIL_ENDPOINT: GhnEndpoint = '/v2/shipping-order/detail';

// Nhãn cho lỗi ở gốc `data`/thân phản hồi (chỉ dùng trong log dev, không phải dữ liệu GHN).
const ROOT_DATA_PATH = '(data)';
const ROOT_BODY_PATH = '(body)';
const MAX_PATH_SEGMENT_LENGTH = 40;
// Mã lỗi mạng chỉ nhận dạng máy đọc được; mọi thứ khác quy về 'unknown' để không lộ URL/host.
const ERRNO_PATTERN = /^[A-Z0-9_]{1,32}$/;
// Token chỉ được chứa ký tự ASCII in được, không khoảng trắng/xuống dòng/điều khiển.
const TOKEN_PATTERN = /^[\x21-\x7E]+$/;

/** Tùy chọn của `createGhnClient`. */
export interface GhnClientOptions {
  /** Nguồn thông tin đăng nhập; được gọi cho MỖI lời gọi. */
  credentials: CredentialProvider;
  /** Tùy chọn; không có thì không ghi log. Chỉ dùng khóa trong allowlist của logger. */
  logger?: ToolLogger;
  /** Hàm fetch; mặc định đọc `globalThis.fetch` tại lúc gọi (để mock toàn cục hoạt động). */
  fetch?: typeof fetch;
  /** Thời gian chờ mỗi lần thử, mặc định 6000 ms; phải là số hữu hạn > 0. */
  timeoutMs?: number;
  /** Thời gian chờ trước khi thử lại, mặc định 300 ms; phải là số hữu hạn >= 0. */
  retryDelayMs?: number;
  /** Hàm chờ; test truyền bản trả ngay để không phải chờ thật. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Đọc trường chuỗi từ thân JSON; không phải object hoặc sai kiểu thì trả undefined.
function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

// Lấy mã lỗi mạng dạng chuỗi an toàn từ `cause.code` hoặc `error.code`.
function readErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const code = value['code'];
  return typeof code === 'string' && ERRNO_PATTERN.test(code) ? code : undefined;
}

// `errno` cho GHN_NETWORK; không bao giờ chứa hostname/URL/header.
function extractErrno(error: unknown): string {
  if (!isRecord(error)) {
    return 'unknown';
  }
  return readErrorCode(error['cause']) ?? readErrorCode(error) ?? 'unknown';
}

// AbortSignal.timeout tạo lỗi tên TimeoutError; AbortError phòng khi bị hủy cách khác.
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

// Chuẩn hoá mã HTTP trong thân GHN: số nguyên, hoặc chuỗi số (ví dụ '400').
function normalizeHttpCode(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

// Mã HTTP hiệu lực trong thân phản hồi 2xx; undefined nếu thiếu/sai kiểu.
function readBodyHttpCode(body: unknown): number | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return normalizeHttpCode(body['code']);
}

// Mã cho tham số `code` của GHN_BAD_REQUEST: chỉ số nguyên 100..599, còn lại 'unknown'.
function extractGhnCode(body: unknown): string {
  if (!isRecord(body)) {
    return 'unknown';
  }
  const code = normalizeHttpCode(body['code']);
  return code !== undefined && code >= 100 && code <= 599 ? String(code) : 'unknown';
}

// "Không tìm thấy đơn": CHỈ endpoint detail, trạng thái hiệu lực 400, message GHN chứa
// "không tồn tại" (trạng thái hiệu lực là HTTP status ở nhánh 4xx, là `code` trong thân ở 2xx).
function isOrderNotFound(endpoint: GhnEndpoint, effectiveStatus: number, body: unknown): boolean {
  if (endpoint !== ORDER_DETAIL_ENDPOINT || effectiveStatus !== 400) {
    return false;
  }
  const message = readStringField(body, 'message');
  return message !== undefined && message.toLowerCase().includes('không tồn tại');
}

function readOrderCode(payload: Readonly<Record<string, unknown>>): string {
  const value = payload['order_code'];
  return typeof value === 'string' ? value : '(không rõ)';
}

function sanitizePathSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9_.-]/g, '?');
  return cleaned.length <= MAX_PATH_SEGMENT_LENGTH
    ? cleaned
    : `${cleaned.slice(0, MAX_PATH_SEGMENT_LENGTH - 1)}…`;
}

// Đường dẫn trường lỗi của Zod, chỉ giữ tên trường (đã làm sạch), không bao giờ chứa giá trị.
function formatSchemaPath(path: ReadonlyArray<string | number> | undefined): string {
  if (path === undefined || path.length === 0) {
    return ROOT_DATA_PATH;
  }
  return path
    .map((segment) =>
      typeof segment === 'number' ? String(segment) : sanitizePathSegment(segment),
    )
    .join('.');
}

// Phần dữ liệu của phản hồi GHN (chỉ `data` được giao cho schema của tool).
function getResponseData(body: unknown): unknown {
  return isRecord(body) ? body['data'] : undefined;
}

// Kiểm token/ShopId TRƯỚC khi gọi mạng; thông báo chỉ nêu TÊN biến, không nêu giá trị.
function assertValidCredentials(credentials: GhnCredentials): void {
  if (!TOKEN_PATTERN.test(credentials.token)) {
    throw createAppError('CONFIG_MISSING', {
      'tên biến': 'GHN_TOKEN',
      name: 'GHN_TOKEN',
    });
  }
  const shopId = credentials.shopId;
  if (shopId !== undefined && (!Number.isSafeInteger(shopId) || shopId <= 0)) {
    throw createAppError('CONFIG_MISSING', {
      'tên biến': 'GHN_SHOP_ID',
      name: 'GHN_SHOP_ID',
    });
  }
}

// GET: chỉ nhận string/number hữu hạn/boolean; undefined bị bỏ qua; khóa rỗng và giá trị
// phức tạp là lỗi lập trình, dừng ngay thay vì tự đoán cách mã hóa.
function buildQueryString(payload: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (key === '') {
      throw createAppError('INTERNAL_ERROR');
    }
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw createAppError('INTERNAL_ERROR');
      }
      params.append(key, String(value));
      continue;
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      params.append(key, String(value));
      continue;
    }
    throw createAppError('INTERNAL_ERROR');
  }
  return params.toString();
}

function buildRequestUrl(
  env: GhnEnvironment,
  endpoint: GhnEndpoint,
  payload: Readonly<Record<string, unknown>>,
  method: HttpMethod,
): string {
  const baseUrl = `${getBaseUrl(env)}${endpoint}`;
  if (method !== 'GET') {
    return baseUrl;
  }
  const query = buildQueryString(payload);
  return query === '' ? baseUrl : `${baseUrl}?${query}`;
}

function buildHeaders(credentials: GhnCredentials, method: HttpMethod): Record<string, string> {
  const headers: Record<string, string> = { Token: credentials.token };
  if (credentials.shopId !== undefined) {
    headers['ShopId'] = String(credentials.shopId);
  }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

// Đọc thân dạng văn bản rồi JSON.parse. Lỗi timeout/abort khi đọc thân được NÉM LẠI để vòng
// lặp xử lý như timeout (thử lại rồi GHN_TIMEOUT); lỗi đọc/parse khác trả undefined.
async function readJsonBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw error;
    }
    return undefined;
  }
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// Hủy thân chưa đọc (401/429/5xx) để giải phóng kết nối; lỗi hủy không làm đổi kết quả.
async function cancelUnreadBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Bỏ qua.
  }
}

/**
 * Tạo `GhnGateway` gọi GHN.
 *
 * - `getCredentials()` được gọi cho mỗi lời gọi, nên token/ShopId lấy mới mỗi lần;
 *   token/ShopId sai định dạng bị chặn TRƯỚC khi gọi mạng (`CONFIG_MISSING`).
 * - 5xx và timeout (kể cả timeout khi đang đọc thân): thử lại đúng 1 lần; 401/429/lỗi mạng/4xx:
 *   không thử lại.
 * - Mọi lỗi ném ra là `AppError`; `cause` (nếu có) là `Error` mới an toàn, KHÔNG phải lỗi fetch thô.
 * - Log (nếu có `logger`): một dòng `ghn_call` khi kết thúc + một dòng `ghn_retry` mỗi lần thử lại;
 *   chỉ dùng khóa `event`, `ms`, `httpStatus`, `code`. Logger ném lỗi không làm đổi kết quả.
 */
export function createGhnClient(options: GhnClientOptions): GhnGateway {
  const logger = options.logger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const injectedFetch = options.fetch;

  // Cấu hình thời gian sai là lỗi lập trình: báo sớm, không để chạy với giá trị vô nghĩa.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('createGhnClient: timeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('createGhnClient: retryDelayMs must be a non-negative finite number');
  }

  // Gọi logger an toàn: logger hỏng không được làm đổi kết quả của request.
  function safeLog(
    level: 'info' | 'warn' | 'error',
    fields: Readonly<Record<string, string | number>>,
  ): void {
    if (logger === undefined) {
      return;
    }
    try {
      if (level === 'info') {
        logger.info(fields);
      } else if (level === 'warn') {
        logger.warn(fields);
      } else {
        logger.error(fields);
      }
    } catch {
      // Nuốt lỗi logger.
    }
  }

  // Ghi MỘT dòng ghn_call cho mỗi lời gọi (thành công hoặc lỗi cuối cùng).
  function logCall(level: 'info' | 'error', ms: number, httpStatus?: number, code?: string): void {
    safeLog(level, {
      event: 'ghn_call',
      ms,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(code !== undefined ? { code } : {}),
    });
  }

  async function request<T>(
    endpoint: GhnEndpoint,
    payload: Readonly<Record<string, unknown>>,
    responseSchema: ZodType<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    let lastHttpStatus: number | undefined;

    // Toàn bộ logic bên trong; lỗi được chuẩn hoá và log một lần ở ngoài.
    const perform = async (): Promise<T> => {
      const credentials = await options.credentials.getCredentials();
      assertValidCredentials(credentials);
      const method = ENDPOINT_METHODS[endpoint];
      const url = buildRequestUrl(credentials.env, endpoint, payload, method);
      const headers = buildHeaders(credentials, method);
      const requestBody = method === 'POST' ? JSON.stringify(payload) : undefined;
      // Đọc globalThis.fetch tại lúc gọi để mock toàn cục hoạt động.
      const doFetch: typeof fetch =
        injectedFetch ?? ((input, init) => globalThis.fetch(input, init));

      // Chờ rồi trả true nếu còn lượt thử; false nếu đã hết lượt (nơi gọi ném GHN_TIMEOUT).
      const retryAfterTimeout = async (attempt: number): Promise<boolean> => {
        if (attempt >= MAX_ATTEMPTS) {
          return false;
        }
        safeLog('warn', { event: 'ghn_retry', code: 'GHN_TIMEOUT' });
        await sleep(retryDelayMs);
        return true;
      };

      // Đọc thân; timeout khi đọc thân được xử lý như timeout của lời gọi.
      const readBodyForAttempt = async (
        response: Response,
        attempt: number,
      ): Promise<{ retry: true } | { retry: false; body: unknown }> => {
        try {
          return { retry: false, body: await readJsonBody(response) };
        } catch (error) {
          if (!isTimeoutError(error)) {
            throw error;
          }
          if (await retryAfterTimeout(attempt)) {
            return { retry: true };
          }
          throw createAppError(
            'GHN_TIMEOUT',
            { ms: timeoutMs },
            {
              // Không gắn lỗi fetch thô: nó có thể chứa token/URL.
              cause: new Error('TimeoutError'),
            },
          );
        }
      };

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        lastHttpStatus = undefined;

        let response: Response;
        try {
          response = await doFetch(url, {
            method,
            headers,
            body: requestBody,
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          if (isTimeoutError(error)) {
            if (await retryAfterTimeout(attempt)) {
              continue;
            }
            throw createAppError(
              'GHN_TIMEOUT',
              { ms: timeoutMs },
              {
                // Không gắn lỗi fetch thô: nó có thể chứa token/URL.
                cause: new Error('TimeoutError'),
              },
            );
          }
          const errno = extractErrno(error);
          throw createAppError(
            'GHN_NETWORK',
            { errno },
            {
              // Cause an toàn: chỉ chứa errno đã làm sạch, không chứa hostname/URL/token.
              cause: new Error(errno),
            },
          );
        }

        lastHttpStatus = response.status;

        if (response.status === 401) {
          await cancelUnreadBody(response);
          throw createAppError('GHN_UNAUTHORIZED');
        }
        if (response.status === 429) {
          await cancelUnreadBody(response);
          throw createAppError('GHN_RATE_LIMITED');
        }

        if (response.status >= 500) {
          await cancelUnreadBody(response);
          if (attempt < MAX_ATTEMPTS) {
            safeLog('warn', {
              event: 'ghn_retry',
              httpStatus: response.status,
              code: 'GHN_SERVER_ERROR',
            });
            await sleep(retryDelayMs);
            continue;
          }
          throw createAppError('GHN_SERVER_ERROR');
        }

        // 4xx khác 401/429 (kể cả 403): xét "không tìm thấy đơn" trước rồi mới báo chung.
        if (!response.ok) {
          const read = await readBodyForAttempt(response, attempt);
          if (read.retry) {
            continue;
          }
          if (isOrderNotFound(endpoint, response.status, read.body)) {
            throw createAppError('GHN_ORDER_NOT_FOUND', { order_code: readOrderCode(payload) });
          }
          throw createAppError('GHN_BAD_REQUEST', {
            status: response.status,
            code: extractGhnCode(read.body),
          });
        }

        // 2xx: đọc thân JSON; thân rỗng/không phải JSON là phản hồi sai dạng.
        const read = await readBodyForAttempt(response, attempt);
        if (read.retry) {
          continue;
        }
        const body = read.body;
        if (body === undefined) {
          throw createAppError('GHN_UNEXPECTED_RESPONSE', { path: ROOT_BODY_PATH });
        }

        // `code` trong thân phải là số hợp lệ; thiếu/sai kiểu ở 2xx là phản hồi sai dạng.
        const bodyCode = readBodyHttpCode(body);
        if (bodyCode === undefined) {
          throw createAppError('GHN_UNEXPECTED_RESPONSE', { path: ROOT_BODY_PATH });
        }

        if (bodyCode !== 200 && bodyCode !== 201) {
          // `code` trong thân là trạng thái hiệu lực khi phân loại lỗi nghiệp vụ.
          if (isOrderNotFound(endpoint, bodyCode, body)) {
            throw createAppError('GHN_ORDER_NOT_FOUND', { order_code: readOrderCode(payload) });
          }
          throw createAppError('GHN_BAD_REQUEST', {
            status: response.status,
            code: extractGhnCode(body),
          });
        }

        const parsed = responseSchema.safeParse(getResponseData(body));
        if (!parsed.success) {
          throw createAppError('GHN_UNEXPECTED_RESPONSE', {
            path: formatSchemaPath(parsed.error.issues[0]?.path),
          });
        }
        return parsed.data;
      }

      // Không tới được: vòng lặp luôn trả dữ liệu hoặc ném lỗi ở lần thử cuối.
      throw createAppError('INTERNAL_ERROR');
    };

    try {
      const data = await perform();
      logCall('info', Math.round(performance.now() - startedAt), lastHttpStatus);
      return data;
    } catch (error) {
      const appError = toAppError(error);
      logCall('error', Math.round(performance.now() - startedAt), lastHttpStatus, appError.code);
      throw appError;
    }
  }

  return { request };
}
