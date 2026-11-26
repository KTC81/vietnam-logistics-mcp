/**
 * Đọc và kiểm tra biến môi trường bằng Zod.
 *
 * Đây là NƠI DUY NHẤT trong mã đọc `process.env` (qua tham số mặc định của `loadConfig`).
 * Tool và core không được đọc biến môi trường trực tiếp (xem quy tắc import trong eslint.config.js).
 *
 * Hiện chỉ dùng `GHN_TOKEN`, `GHN_SHOP_ID`, `GHN_ENV`; các biến khác chưa được đọc.
 */
import { z } from 'zod';
import { createAppError } from '../core/errors.js';
import type {
  CredentialProvider,
  GhnCredentials,
  GhnEnvironment,
  ValidationIssue,
} from '../core/types.js';
import type { LogLevel } from '../utils/logger.js';

/**
 * Nguồn biến môi trường. Mặc định là `process.env`; test truyền object giả vào
 * `loadConfig` để không phụ thuộc máy chạy test.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Host GHN theo môi trường.
 *
 * Staging dùng `dev-online-gateway.ghn.vn` như code mẫu cũ; host `.ghn.dev` không tồn tại
 * (đã kiểm tra ngày 2026-11-17).
 */
const GHN_BASE_URLS: Readonly<Record<GhnEnvironment, string>> = {
  production: 'https://online-gateway.ghn.vn/shiip/public-api',
  staging: 'https://dev-online-gateway.ghn.vn/shiip/public-api',
};

// Chuỗi rỗng hoặc chỉ khoảng trắng -> undefined (dùng giá trị mặc định của schema);
// giá trị không phải chuỗi giữ nguyên để Zod báo lỗi sai kiểu.
function optionalTrimmed(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Các mức log hợp lệ. */
const LOG_LEVELS = ['info', 'warn', 'error'] as const;

/**
 * Hợp đồng biến môi trường.
 * - `GHN_TOKEN`: bắt buộc, cắt khoảng trắng, không rỗng;
 * - `GHN_SHOP_ID`: tuỳ chọn ở tầng cấu hình; nếu có phải là số nguyên dương;
 * - `GHN_ENV`: `production` (mặc định khi bỏ trống) hoặc `staging`;
 * - `LOG_LEVEL`: `info` (mặc định), `warn`, `error`; giá trị lạ hoặc bỏ trống KHÔNG làm sập
 *   server mà coi như `info` (nhất quán với logger).
 */
const envSchema = z.object({
  GHN_TOKEN: z.string().trim().min(1),
  GHN_SHOP_ID: z.preprocess(
    optionalTrimmed,
    z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .transform((value) => Number(value))
      // Chỉ nhận số nguyên dương an toàn: chuỗi quá dài sẽ bị Number() làm tròn thành sai số.
      .refine((value) => Number.isSafeInteger(value))
      .optional(),
  ),
  GHN_ENV: z.preprocess(optionalTrimmed, z.enum(['production', 'staging']).default('production')),
  LOG_LEVEL: z.preprocess(optionalTrimmed, z.enum(LOG_LEVELS).catch('info')),
});

/** Cấu hình đã kiểm tra của gói Local. */
export interface AppConfigInit {
  ghnToken: string;
  shopId?: number;
  ghnEnv: GhnEnvironment;
  logLevel: LogLevel;
}

/**
 * Cấu hình đã kiểm tra.
 *
 * Token được giữ trong trường riêng tư và chỉ lấy ra qua `getGhnToken()`;
 * `JSON.stringify(config)` gọi `toJSON()` nên chỉ thấy giá trị che, còn `String(config)`
 * trả `[object Object]` — cả hai không lộ token.
 */
export class AppConfig {
  readonly shopId: number | undefined;
  readonly ghnEnv: GhnEnvironment;
  readonly logLevel: LogLevel;
  readonly #ghnToken: string;

  constructor(init: AppConfigInit) {
    this.#ghnToken = init.ghnToken;
    this.shopId = init.shopId;
    this.ghnEnv = init.ghnEnv;
    this.logLevel = init.logLevel;
  }

  /** Lấy token GHN để gửi trong header; KHÔNG log, KHÔNG đưa vào thông báo lỗi. */
  getGhnToken(): string {
    return this.#ghnToken;
  }

  /** Dạng an toàn khi in: token luôn bị che. */
  toJSON(): {
    ghnToken: string;
    shopId: number | undefined;
    ghnEnv: GhnEnvironment;
    logLevel: LogLevel;
  } {
    return {
      ghnToken: '[đã ẩn]',
      shopId: this.shopId,
      ghnEnv: this.ghnEnv,
      logLevel: this.logLevel,
    };
  }
}

// Gom lỗi của Zod thành tên biến thiếu và danh sách lỗi định dạng, không lộ giá trị đã nhập.
function buildConfigError(issues: readonly z.ZodIssue[]): never {
  const missing: string[] = [];
  const formatIssues: ValidationIssue[] = [];

  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field !== 'string') {
      continue;
    }
    if (field === 'GHN_TOKEN') {
      if (!missing.includes(field)) {
        missing.push(field);
      }
      continue;
    }
    if (formatIssues.some((item) => item.field === field)) {
      continue;
    }
    let message: string;
    if (field === 'GHN_SHOP_ID') {
      // Lỗi 'custom' đến từ refine an toàn số nguyên, khác lỗi định dạng ở regex.
      message =
        issue.code === 'custom'
          ? 'phải là số nguyên dương không vượt quá giới hạn số nguyên an toàn'
          : 'phải là số nguyên dương';
    } else {
      message = "phải là 'production' hoặc 'staging'";
    }
    formatIssues.push({ field, message });
  }

  // Thiếu biến bắt buộc được báo trước, liệt kê đủ tên biến trong một thông báo.
  if (missing.length > 0) {
    throw createAppError('CONFIG_MISSING', {
      'tên biến': missing.join(', '),
      name: missing.join(', '),
    });
  }

  const fields = formatIssues.map((item) => item.field).join(', ');
  throw createAppError(
    'VALIDATION_ERROR',
    {
      trường: fields,
      'lý do': formatIssues.map((item) => item.message).join('; '),
      fields,
    },
    { issues: formatIssues },
  );
}

/**
 * Đọc và kiểm tra cấu hình từ biến môi trường.
 *
 * Thiếu `GHN_TOKEN`: ném `AppError` mã `CONFIG_MISSING`, thông báo tiếng Việt chỉ tên biến
 * (không in giá trị). Sai định dạng (`GHN_SHOP_ID` không phải số nguyên dương hoặc vượt
 * giới hạn số nguyên an toàn của JavaScript, `GHN_ENV` ngoài hai giá trị hợp lệ):
 * ném `VALIDATION_ERROR` kèm danh sách `issues`. `LOG_LEVEL` lạ không gây lỗi (coi như `info`).
 */
export function loadConfig(env: EnvSource = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    buildConfigError(result.error.issues);
  }

  return new AppConfig({
    ghnToken: result.data.GHN_TOKEN,
    shopId: result.data.GHN_SHOP_ID,
    ghnEnv: result.data.GHN_ENV,
    logLevel: result.data.LOG_LEVEL,
  });
}

/**
 * Hàm DUY NHẤT lấy ShopId từ cấu hình.
 * Hiện chỉ trả giá trị đã cấu hình hoặc `undefined`; nơi khác có thể bổ sung cách tự dò
 * ShopId tại đúng hàm này mà không phải sửa chỗ gọi.
 */
export function resolveShopId(config: AppConfig): number | undefined {
  return config.shopId;
}

/** Host API GHN theo môi trường (không có dấu `/` ở cuối). */
export function getBaseUrl(env: GhnEnvironment): string {
  return GHN_BASE_URLS[env];
}

/**
 * Bản `CredentialProvider` hiện tại: trả thông tin đăng nhập GHN từ cấu hình đã nạp.
 *
 * Có thể thay bằng bản lấy token/ShopId từ nguồn khác (ví dụ header của từng request);
 * token và shopId không bao giờ được ghi log.
 */
export class EnvCredentialProvider implements CredentialProvider {
  readonly #config: AppConfig;

  constructor(config: AppConfig) {
    this.#config = config;
  }

  async getCredentials(): Promise<GhnCredentials> {
    return {
      token: this.#config.getGhnToken(),
      shopId: resolveShopId(this.#config),
      env: this.#config.ghnEnv,
    };
  }
}
