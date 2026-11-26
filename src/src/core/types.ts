/**
 * Kiểu dữ liệu dùng chung của lõi.
 *
 * File này CHỈ khai báo kiểu, không chứa logic. Một số giao diện (`LicenseChecker`,
 * `IdempotencyStore`, `KeyValueCache`) chưa có cài đặt đầy đủ; khai báo sẵn để các tầng
 * dựng trên chúng mà không phải sửa chữ ký tool khi bổ sung cài đặt.
 */
import type { ZodType, ZodTypeAny } from 'zod';

/**
 * Nhóm sử dụng của một tool.
 * `AllowAll` trả `'all'` (cho phép mọi tool); các tool khai báo nhóm `'free'`.
 */
export type Tier = 'free' | 'all';

/** Môi trường GHN mà server gọi tới. */
export type GhnEnvironment = 'production' | 'staging';

/**
 * Thông tin đăng nhập GHN của một lời gọi.
 * Token chỉ đi vào header gọi GHN, không log, không đưa vào thông báo lỗi.
 */
export interface GhnCredentials {
  token: string;
  /** Có thể vắng; khi chỉ có token, nơi cung cấp có thể tự xác định ShopId. */
  shopId?: number;
  env: GhnEnvironment;
}

/**
 * Nguồn thông tin đăng nhập theo từng lời gọi.
 * Bản hiện tại đọc từ cấu hình đã nạp; có thể thay bằng bản lấy từ nguồn khác.
 */
export interface CredentialProvider {
  getCredentials(): Promise<GhnCredentials>;
}

/** Một lỗi đầu vào, hiển thị trong `error.issues` của kết quả tool. */
export interface ValidationIssue {
  field: string;
  message: string;
}

/** Phần lỗi của kết quả tool; `code` là một giá trị của `ErrorCode` trong core/errors.ts. */
export interface ToolErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  /** Chỉ có khi `code = VALIDATION_ERROR`. */
  issues?: ValidationIssue[];
}

/** Siêu dữ liệu kèm mọi kết quả tool; `tookMs` là thời gian xử lý (ms) nếu có. */
export interface ToolMeta {
  requestId: string;
  tookMs?: number;
  cached?: boolean;
}

/** Kết quả tool thành công. */
export interface ToolSuccess<T> {
  ok: true;
  data: T;
  meta: ToolMeta;
}

/** Kết quả tool lỗi; không chứa stack hay thông điệp tiếng Anh cho dev. */
export interface ToolFailure {
  ok: false;
  error: ToolErrorInfo;
  meta: ToolMeta;
}

/** Dạng kết quả chung của mọi tool. */
export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

/**
 * Các trường được phép ghi log (allowlist). Chi tiết cách ghi ở utils/logger.ts;
 * ở đây chỉ khai báo kiểu tối thiểu mà tool nhận qua `ctx.logger`.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Giao diện logger tối thiểu mà handler tool nhận qua `ToolContext`. */
export interface ToolLogger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

/** Endpoint GHN mà server dùng. */
export type GhnEndpoint =
  | '/v2/shipping-order/detail'
  | '/v2/shop/all'
  | '/v2/shipping-order/fee'
  | '/v2/shipping-order/available-services';

/**
 * Cổng gọi GHN mà tool nhận qua `ctx.services.ghn` (tool không tự gọi mạng).
 * Client quyết định phương thức theo endpoint: GET đưa `payload` vào query string,
 * POST đưa vào body JSON — tool không cần biết. Phần `data` của phản hồi được kiểm bằng
 * `responseSchema` (allowlist trường do tool định nghĩa), nên dữ liệu cá nhân GHN trả thừa
 * bị Zod loại bỏ trước khi tới tool.
 */
export interface GhnGateway {
  /** Gọi một endpoint GHN và trả phần `data` đã kiểm bằng `responseSchema`. */
  request<T>(
    endpoint: GhnEndpoint,
    payload: Readonly<Record<string, unknown>>,
    responseSchema: ZodType<T>,
  ): Promise<T>;
}

/**
 * Kho đệm khóa–giá trị có thời hạn. Hiện chỉ khai báo kiểu;
 * cài đặt cụ thể bổ sung sau.
 */
export interface KeyValueCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Trạng thái trả về của `IdempotencyStore.begin`. */
export type IdempotencyBeginState = 'started' | 'replayed' | 'in_progress' | 'mismatch' | 'unknown';

/** Kết quả `IdempotencyStore.begin`; `result` chỉ có khi `state = 'replayed'`. */
export interface IdempotencyBeginResult {
  state: IdempotencyBeginState;
  result?: unknown;
}

/**
 * Kho khóa chống tạo trùng. Hiện chỉ khai báo kiểu;
 * cài đặt cụ thể bổ sung sau.
 */
export interface IdempotencyStore {
  begin(key: string, payloadHash: string): Promise<IdempotencyBeginResult>;
  done(key: string, result: unknown): Promise<void>;
  markUnknown(key: string): Promise<void>;
}

/** Kết quả kiểm tra quyền cho một lời gọi. */
export interface LicenseVerdict {
  valid: boolean;
  tier: Tier;
  /** Hạn mức lượt đặt tay; `null` = không giới hạn. */
  quota?: number | null;
  /** Số lượt đã dùng trong kỳ hiện tại. */
  used?: number;
}

/** Ngữ cảnh tối thiểu để `LicenseChecker` kiểm tra quyền (`AllowAll` không gọi mạng). */
export interface LicenseCheckContext {
  requestId: string;
  logger: ToolLogger;
}

/** Cổng kiểm tra quyền. */
export interface LicenseChecker {
  check(ctx: LicenseCheckContext): Promise<LicenseVerdict>;
}

/** Cổng mà tool được phép dùng, truyền qua `ToolContext.services`. */
export interface ToolServices {
  ghn: GhnGateway;
  /** Chưa có giá trị mặc định; bổ sung khi có tool ghi. */
  idempotencyStore?: IdempotencyStore;
  /** Chưa có giá trị mặc định; bổ sung khi cần đệm dữ liệu. */
  cache?: KeyValueCache;
}

/**
 * Ngữ cảnh của một lời gọi tool. Dựng một lần lúc khởi động;
 * có thể dựng mới cho mỗi lời gọi khi cần.
 */
export interface ToolContext {
  credentials: GhnCredentials;
  tier: Tier;
  requestId: string;
  logger: ToolLogger;
  services: ToolServices;
}

/**
 * Khai báo một tool theo cách độc lập transport: registry/server đọc kiểu này
 * để đăng ký với SDK MCP. Handler là hàm thuần `(input, ctx)`, không biết stdio hay HTTP.
 */
export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  /** Một nguồn sự thật cho hợp đồng đầu vào; server dùng để validate trước khi chạy handler. */
  inputSchema: ZodType<Input>;
  tier: Tier;
  handler: (input: Input, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Dạng đã XÓA KIỂU ĐẦU VÀO để registry lưu mọi `ToolDefinition<Input>` khác nhau.
 *
 * `inputSchema` dùng `ZodTypeAny` (kiểu "mọi schema Zod" của thư viện, không phải `any` trần);
 * handler nhận `never` vì server đã chạy `parseInput` trước khi gọi. Nhờ vậy
 * `ToolDefinition<Input>` bất kỳ đều gán được vào kiểu này mà không cần ép kiểu ở tool.
 */
export type StoredToolDefinition = Omit<ToolDefinition<never>, 'inputSchema' | 'handler'> & {
  inputSchema: ZodTypeAny;
  handler: (input: never, ctx: ToolContext) => Promise<unknown>;
};

/** Nơi đăng ký tool. */
export interface ToolRegistry {
  /** Đăng ký một tool; ném lỗi lập trình nếu tên trùng hoặc sai định dạng. */
  register(tool: StoredToolDefinition): void;
  /** Đăng ký nhiều tool cùng lúc (điểm mở rộng cho bên ngoài); hoàn tác cả lô nếu có tool lỗi. */
  registerTools(tools: readonly StoredToolDefinition[]): void;
  /** Danh sách tool đã đăng ký, theo thứ tự đăng ký; trả bản sao mảng. */
  list(): readonly StoredToolDefinition[];
  get(name: string): StoredToolDefinition | undefined;
}

/**
 * Kiểu mỏng bọc server MCP của SDK để `core/` không phụ thuộc SDK.
 * `transport` do tầng transports quyết định nên ở đây để `unknown`.
 */
export interface McpServerHandle {
  /** Nối server vào kênh giao tiếp do transport cung cấp. */
  connect(transport: unknown): Promise<void>;
  /** Đóng server và kênh giao tiếp. */
  close(): Promise<void>;
}

/** Cách nối một server MCP đã dựng với kênh giao tiếp. Hiện chỉ có `stdio`. */
export interface TransportFactory {
  readonly name: 'stdio' | 'http';
  /** Nối server vào kênh; trả khi sẵn sàng nhận lời gọi. */
  start(server: McpServerHandle): Promise<void>;
  /** Đóng gọn khi thoát tiến trình. */
  stop(): Promise<void>;
}
