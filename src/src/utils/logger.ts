/**
 * Logger ghi stderr theo allowlist.
 *
 * NGUYÊN TẮC:
 * - stdout bị CẤM: stdout dành cho kênh stdio của MCP, ghi nhầm sẽ làm hỏng kết nối.
 * - Allowlist là cơ chế chính: chỉ đọc và ghi các khóa nằm trong danh sách cố định; KHÔNG
 *   "lọc chuỗi nhạy cảm" trên dữ liệu người gọi đưa vào. Khóa lạ bị bỏ và KHÔNG đọc giá trị.
 * - Logger KHÔNG BAO GIỜ ném lỗi ra ngoài: mọi lỗi khi dựng/ghi dòng bị nuốt để không làm
 *   sập tiến trình hay che lỗi gốc của tool.
 *
 * Cách gọi: chỉ truyền các trường thuộc allowlist, ví dụ:
 *   logger.info({ event: 'tool_call', tool: 'ghn_get_order_detail', ms: 310,
 *                 httpStatus: 200, requestId: 'req_7f3a9c' });
 *   logger.error({ event: 'tool_error', tool: ctx.tool, code: err.code, requestId });
 * Với lỗi, dùng `logFieldsFromError(err)` để chỉ lấy mã lỗi; không log cause/message/stack.
 */
import { isAppError, type ErrorCode } from '../core/errors.js';
import type { LogFields, ToolLogger } from '../core/types.js';

/** Mức log; dòng có mức thấp hơn mức tối thiểu bị bỏ. */
export type LogLevel = 'info' | 'warn' | 'error';

/** Tùy chọn của `createLogger`; tất cả có giá trị mặc định. */
export interface LoggerOptions {
  /** Mức tối thiểu, mặc định `'info'`. Giá trị không hợp lệ cũng được coi như `'info'`. */
  level?: LogLevel;
  /** Hàm ghi một dòng; mặc định ghi vào `process.stderr`. Dùng để test bắt đầu ra. */
  write?: (line: string) => void;
  /** Nguồn thời gian; mặc định `() => new Date()`. Dùng để test ổn định. */
  now?: () => Date;
}

// Thứ tự mức log; dòng có trọng số nhỏ hơn mức tối thiểu bị bỏ.
const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  info: 0,
  warn: 1,
  error: 2,
};

// Mức không hợp lệ (cấu hình/ép kiểu sai) coi như 'info' để không rơi vào fail-open ghi tất cả.
// Kiểm `typeof` trước khi tra cứu để không bao giờ ép một object lạ thành khóa (toString có thể ném).
function resolveMinSeverity(level: LogLevel | undefined): number {
  if (typeof level === 'string' && Object.hasOwn(LEVEL_SEVERITY, level)) {
    return LEVEL_SEVERITY[level];
  }
  return LEVEL_SEVERITY.info;
}

// Giới hạn định dạng cho từng trường được phép ghi.
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

function isToolName(value: unknown): boolean {
  return typeof value === 'string' && TOOL_PATTERN.test(value);
}

function isErrorCode(value: unknown): boolean {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value);
}

function isDurationMs(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isHttpStatus(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isRequestId(value: unknown): boolean {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

function isEventName(value: unknown): boolean {
  return typeof value === 'string' && EVENT_PATTERN.test(value);
}

// Allowlist cố định: danh sách này vừa quyết định khóa được ghi, vừa quyết định thứ tự trường.
// `event` là nhãn sự kiện ngắn (ví dụ tool_call, retry) — CẦN XÁC NHẬN khi dùng.
const FIELD_RULES: ReadonlyArray<{ key: string; isValid: (value: unknown) => boolean }> = [
  { key: 'tool', isValid: isToolName },
  { key: 'code', isValid: isErrorCode },
  { key: 'ms', isValid: isDurationMs },
  { key: 'httpStatus', isValid: isHttpStatus },
  { key: 'requestId', isValid: isRequestId },
  { key: 'event', isValid: isEventName },
];

const ALLOWED_KEYS: ReadonlySet<string> = new Set(FIELD_RULES.map((rule) => rule.key));

// Ghi mặc định: stderr, không bao giờ stdout.
function defaultWrite(line: string): void {
  process.stderr.write(line);
}

/**
 * Dựng đối tượng một dòng log từ đầu vào người gọi.
 * Khóa lạ chỉ được ĐẾM (không đọc giá trị); trường allowlist sai định dạng bị bỏ.
 * Trả `undefined` khi đầu vào không phải đối tượng (bỏ dòng log).
 */
function buildLogEntry(
  level: LogLevel,
  fields: LogFields,
  now: () => Date,
): Record<string, string | number> | undefined {
  if (fields === null || typeof fields !== 'object') {
    return undefined;
  }

  const input = fields as Readonly<Record<string, unknown>>;
  let dropped = 0;

  // Đếm khóa lạ trước: không đọc giá trị, phòng getter ném lỗi và tránh chạm dữ liệu nhạy cảm.
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      dropped += 1;
    }
  }

  const entry: Record<string, string | number> = {
    ts: now().toISOString(),
    level,
  };

  for (const rule of FIELD_RULES) {
    if (!Object.hasOwn(input, rule.key)) {
      continue;
    }
    const value = input[rule.key];
    if (rule.isValid(value)) {
      entry[rule.key] = value as string | number;
    } else {
      dropped += 1;
    }
  }

  // Chỉ ghi SỐ khóa bị bỏ, không ghi tên khóa (tên khóa có thể là dữ liệu nhạy cảm).
  if (dropped > 0) {
    entry.dropped = dropped;
  }

  return entry;
}

/**
 * Tạo logger ghi stderr theo allowlist.
 *
 * Mỗi lần gọi ghi đúng MỘT dòng JSON kết thúc bằng `\n`, dạng
 * `{"ts":"<ISO 8601>","level":"info|warn|error",...trường hợp lệ}`. Chỉ các trường
 * `tool`, `code`, `ms`, `httpStatus`, `requestId`, `event` được ghi; khóa khác bị bỏ và
 * dòng log thêm `dropped` (số khóa bị bỏ) khi lớn hơn 0.
 *
 * Logger không ném lỗi ra ngoài trong mọi trường hợp (đầu vào lạ, getter/BigInt/đối tượng
 * vòng, `write` lỗi). Không truyền `AppError`, `cause`, `stack`, `messageEn`/`messageVi`
 * vào logger; với lỗi hãy dùng `logFieldsFromError`.
 *
 * `level` không hợp lệ (không phải `'info' | 'warn' | 'error'`) được coi như `'info'`,
 * KHÔNG fail-open ghi tất cả các mức.
 */
export function createLogger(options: LoggerOptions = {}): ToolLogger {
  const minSeverity = resolveMinSeverity(options.level);
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());

  function log(level: LogLevel, fields: LogFields): void {
    try {
      if (LEVEL_SEVERITY[level] < minSeverity) {
        return;
      }
      const entry = buildLogEntry(level, fields, now);
      if (entry === undefined) {
        return;
      }
      write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Nuốt mọi lỗi: logger không được làm sập tiến trình hay che lỗi gốc của tool.
    }
  }

  return {
    info: (fields: LogFields) => log('info', fields),
    warn: (fields: LogFields) => log('warn', fields),
    error: (fields: LogFields) => log('error', fields),
  };
}

/**
 * Trường log an toàn cho một lỗi: CHỈ mã lỗi.
 * `AppError` giữ nguyên mã; lỗi lạ quy về `INTERNAL_ERROR`. Không lấy `cause`, `message`,
 * `stack` hay `messageEn`/`messageVi` để tránh lọt dữ liệu nhạy cảm vào log.
 */
export function logFieldsFromError(error: unknown): { code: ErrorCode } {
  return { code: isAppError(error) ? error.code : 'INTERNAL_ERROR' };
}
