/**
 * Schema Zod dùng chung và `parseInput`.
 *
 * - Mọi schema ở đây có thông báo lỗi tiếng Việt và KHÔNG chèn giá trị người dùng nhập.
 * - `parseInput` chuyển lỗi Zod thành `AppError` mã `VALIDATION_ERROR`,
 *   dùng `errorMap` theo từng lần gọi (không đổi errorMap toàn cục của Zod).
 * - `parseInput` KHÔNG tự ép `.strict()`; schema của từng tool quyết định điều đó.
 */
import { ZodIssueCode, z, type ZodError, type ZodErrorMap, type ZodTypeAny } from 'zod';
import { AppError, createAppError } from '../core/errors.js';
import type { ValidationIssue } from '../core/types.js';

/** Số lỗi tối đa trả trong `issues` (GIẢ ĐỊNH, tránh phản hồi quá dài — CẦN XÁC NHẬN). */
const MAX_VALIDATION_ISSUES = 10;

/** Nhãn trường khi lỗi nằm ở gốc dữ liệu (path rỗng). */
const ROOT_FIELD = '(đầu vào)';

// Mã vận đơn GHN: 5-20 ký tự chữ/số. Đây là GIẢ ĐỊNH; định dạng
// thật của GHN CẦN XÁC NHẬN — sửa một chỗ ở đây nếu cần.
const ORDER_CODE_PATTERN = /^[A-Za-z0-9]+$/;

/** Mã vận đơn: cắt khoảng trắng, 5-20 ký tự chữ và số. */
export const orderCodeSchema = z
  .string({ invalid_type_error: 'Mã vận đơn phải là chuỗi' })
  .trim()
  .min(5, 'Mã vận đơn phải có ít nhất 5 ký tự')
  .max(20, 'Mã vận đơn không được dài quá 20 ký tự')
  .regex(ORDER_CODE_PATTERN, 'Mã vận đơn chỉ gồm chữ và số');

/** UUID chuẩn, dùng cho khóa chống trùng. */
export const uuidSchema = z
  .string({ invalid_type_error: 'Mã chống trùng phải là chuỗi' })
  .trim()
  .uuid('Mã chống trùng phải có dạng UUID');

/**
 * Mã quận/huyện GHN (`from_district_id`, `to_district_id`): số nguyên dương.
 * Chặn cả số vượt giới hạn an toàn (ví dụ 1e21) để không gửi `1e+21` tới GHN.
 */
export const districtIdSchema = z
  .number({ invalid_type_error: 'Mã quận phải là số' })
  .int('Mã quận phải là số nguyên')
  .positive('Mã quận phải lớn hơn 0')
  .refine((value) => Number.isSafeInteger(value), 'Mã quận quá lớn');

/**
 * Mã phường/xã GHN (`to_ward_code`): chuỗi số, cắt khoảng trắng.
 * Schema này CHỈ kiểm định dạng; tính bắt buộc/tùy chọn do schema của tool quyết định.
 */
export const wardCodeSchema = z
  .string({ invalid_type_error: 'Mã phường phải là chuỗi' })
  .trim()
  .regex(/^[0-9]+$/, 'Mã phường phải gồm các chữ số');

/**
 * Cân nặng gram: số nguyên dương. Chặn số vượt giới hạn an toàn để không gửi
 * `1e+21` tới GHN. Trần cân nặng theo GHN: CẦN XÁC NHẬN (hiện KHÔNG đặt trần nghiệp vụ).
 */
export const weightGramSchema = z
  .number({ invalid_type_error: 'Cân nặng phải là số' })
  .int('Cân nặng phải là số nguyên (gram)')
  .positive('Cân nặng phải lớn hơn 0 (gram)')
  .refine((value) => Number.isSafeInteger(value), 'Cân nặng quá lớn');

/**
 * Trần giá trị bảo hiểm (VND). GIẢ ĐỊNH theo mức bảo hiểm GHN thường nhận; CẦN XÁC NHẬN.
 */
const MAX_INSURANCE_VALUE_VND = 50_000_000;

/**
 * Giá trị bảo hiểm VND: số nguyên không âm, mặc định 0.
 * Chặn số vượt giới hạn an toàn và vượt trần nghiệp vụ ở trên.
 */
export const insuranceValueSchema = z
  .number({ invalid_type_error: 'Giá trị bảo hiểm phải là số' })
  .int('Giá trị bảo hiểm phải là số nguyên (VND)')
  .nonnegative('Giá trị bảo hiểm không được âm')
  .max(
    MAX_INSURANCE_VALUE_VND,
    `Giá trị bảo hiểm không được vượt quá ${MAX_INSURANCE_VALUE_VND} VND`,
  )
  .refine((value) => Number.isSafeInteger(value), 'Giá trị bảo hiểm quá lớn')
  .default(0);

/** Độ dài tối đa của một TÊN khóa/trường sau khi làm sạch (gồm cả dấu `…` nếu bị cắt). */
const MAX_NAME_LENGTH = 40;
/** Số khóa lạ liệt kê tối đa trong thông báo; phần còn lại chỉ báo SỐ lượng. */
const MAX_UNKNOWN_KEYS_SHOWN = 5;
/** Ký tự thay thế cho ký tự không an toàn trong tên khóa do người dùng đặt. */
const UNSAFE_CHAR_PLACEHOLDER = '?';
/** Nhãn cho khóa rỗng để thông báo không bị hở khoảng trống cạnh dấu hai chấm. */
const EMPTY_NAME_LABEL = '(rỗng)';
/** Độ dài tối đa của message do schema tự đặt đưa vào issues/thông báo (ĐỀ XUẤT, CẦN XÁC NHẬN). */
const MAX_ISSUE_MESSAGE_LENGTH = 200;

/**
 * Làm sạch một tên khóa/trường do người dùng đặt trước khi đưa vào issues/thông báo:
 * - chỉ giữ `[A-Za-z0-9_.-]`, ký tự khác thay bằng `?`;
 * - khóa rỗng (hoặc rỗng sau khi làm sạch) trả nhãn `(rỗng)`;
 * - cắt còn tối đa 40 ký tự; nếu bị cắt thì lấy 39 ký tự đầu + `…` (tổng vẫn đúng 40).
 *
 * Chấp nhận va chạm tên sau khi làm sạch (ví dụ 'a b' và 'a?b'): đánh đổi để không lộ
 * dữ liệu; chỉ làm issues[].field trùng nhau, không gây lỗi bảo mật.
 */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, UNSAFE_CHAR_PLACEHOLDER);
  if (cleaned.length === 0) {
    return EMPTY_NAME_LABEL;
  }
  if (cleaned.length <= MAX_NAME_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_NAME_LENGTH - 1)}…`;
}

// Liệt kê tối đa 5 khóa lạ đã làm sạch; phần còn lại chỉ báo số khóa, không lộ tên.
// Mỗi tên đặt trong nháy kép để dấu chấm cuối của tên khóa không bị nhầm với dấu chấm câu;
// tên đã qua sanitizeName nên không chứa dấu nháy.
function formatUnknownKeys(keys: readonly string[]): string {
  const shown = keys.slice(0, MAX_UNKNOWN_KEYS_SHOWN).map((key) => `"${sanitizeName(key)}"`);
  const hidden = keys.length - shown.length;
  const list = shown.join(', ');
  return hidden > 0 ? `${list} và ${hidden} khóa khác` : list;
}

/**
 * Error map tiếng Việt dùng cho mỗi lần `parseInput`.
 * Thông báo chung, KHÔNG chèn giá trị nhận được (`received`) hay lựa chọn của enum.
 * Không kết thúc bằng dấu chấm: mẫu `VALIDATION_ERROR` đã có dấu chấm sau `{lý do}`.
 */
const vietnameseErrorMap: ZodErrorMap = (issue) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      return { message: 'Giá trị không đúng kiểu dữ liệu' };
    case ZodIssueCode.too_small:
      return { message: 'Giá trị quá nhỏ hoặc quá ngắn' };
    case ZodIssueCode.too_big:
      return { message: 'Giá trị quá lớn hoặc quá dài' };
    case ZodIssueCode.invalid_string:
      return { message: 'Giá trị không đúng định dạng' };
    case ZodIssueCode.invalid_enum_value:
      return { message: 'Giá trị không nằm trong danh sách cho phép' };
    case ZodIssueCode.unrecognized_keys:
      // Chỉ nêu TÊN khóa lạ (đã làm sạch, tối đa 5, đặt trong nháy), không kèm giá trị.
      return { message: `Có trường không được phép: ${formatUnknownKeys(issue.keys)}` };
    default:
      return { message: 'Dữ liệu nhập chưa hợp lệ' };
  }
};

/**
 * Đường dẫn trường lồng nhau dạng "a.b.0.c"; path rỗng hiển thị nhãn gốc.
 * - Chỉ số mảng giữ nguyên; tên chuỗi do người dùng đặt được làm sạch trước khi ghép.
 * - Cắt 40 ký tự áp dụng theo TỪNG đoạn của đường dẫn, không theo cả đường dẫn.
 * - Dấu `.` được phép trong tên khóa, nên field như "a.b" có thể nhập nhằng giữa khóa "a.b"
 *   và đường dẫn [a, b]; chấp nhận có chủ đích vì field chỉ phục vụ hiển thị.
 */
function formatFieldPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) {
    return ROOT_FIELD;
  }
  return path
    .map((segment) => (typeof segment === 'number' ? String(segment) : sanitizeName(segment)))
    .join('.');
}

/** Câu chung khi message của schema rỗng sau khi cắt dấu chấm/khoảng trắng ở cuối. */
const FALLBACK_ISSUE_MESSAGE = 'Dữ liệu nhập chưa hợp lệ';

// Ký tự bị cắt ở CUỐI message schema: dấu chấm ASCII và mọi khoảng trắng Unicode.
// '…' (U+2026) KHÔNG bị cắt vì là ký tự cắt gọn hợp lệ.
function isTrailingTrimChar(char: string): boolean {
  return char === '.' || /\s/u.test(char);
}

// Cắt dấu chấm/khoảng trắng ở cuối bằng vòng lặp lùi: tuyến tính, tránh regex có thể chậm
// bậc hai với chuỗi dài toàn dấu chấm.
function stripTrailingDots(message: string): string {
  let end = message.length;
  while (end > 0 && isTrailingTrimChar(message[end - 1] ?? '')) {
    end -= 1;
  }
  return message.slice(0, end);
}

// Giới hạn độ dài message schema (ĐỀ XUẤT, CẦN XÁC NHẬN); giữ 199 ký tự đầu + '…'.
function truncateIssueMessage(message: string): string {
  if (message.length <= MAX_ISSUE_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_ISSUE_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Chuẩn hoá message do SCHEMA tự đặt: mẫu VALIDATION_ERROR đã có dấu chấm sau `{lý do}` nên
 * cắt dấu chấm/khoảng trắng ở CUỐI (giữ dấu chấm ở giữa); '...' ASCII bị bỏ, '…' (U+2026)
 * được giữ. Nếu cắt xong không còn nội dung (ví dụ message chỉ là '...'), dùng câu chung.
 */
function normalizeIssueMessage(message: string): string {
  const trimmed = message.trim();
  const stripped = stripTrailingDots(trimmed);
  const withContent = stripped.length > 0 ? stripped : FALLBACK_ISSUE_MESSAGE;
  return truncateIssueMessage(withContent);
}

// Dựng AppError VALIDATION_ERROR từ lỗi Zod; tối đa MAX_VALIDATION_ISSUES lỗi.
function buildValidationError(error: ZodError): AppError {
  // Dùng chung normalizeIssueMessage cho mọi message: message của errorMap nội bộ đều kết thúc
  // bằng ký tự KHÔNG phải dấu chấm (message khóa lạ kết thúc bằng dấu nháy kép hoặc "khóa khác"),
  // và tên khóa nằm trong nháy kép nên dấu chấm cuối của tên khóa không bị cắt.
  const issues: ValidationIssue[] = error.issues.slice(0, MAX_VALIDATION_ISSUES).map((issue) => ({
    field: formatFieldPath(issue.path),
    message: normalizeIssueMessage(issue.message),
  }));

  if (issues.length === 0) {
    issues.push({ field: ROOT_FIELD, message: FALLBACK_ISSUE_MESSAGE });
  }

  const first = issues[0] ?? { field: ROOT_FIELD, message: FALLBACK_ISSUE_MESSAGE };
  // Chỉ nêu TÊN trường (bỏ trùng) để không lộ giá trị; danh sách này dành cho log tiếng Anh.
  const fieldNames = [...new Set(issues.map((issue) => issue.field))].join(', ');

  return createAppError(
    'VALIDATION_ERROR',
    { trường: first.field, 'lý do': first.message, fields: fieldNames },
    { issues },
  );
}

/**
 * Kiểm dữ liệu đầu vào bằng Zod và trả dữ liệu đã chuẩn hoá.
 *
 * Thất bại: ném `AppError` mã `VALIDATION_ERROR` kèm `issues` (`field`, `message` tiếng Việt),
 * tối đa 10 lỗi. Không ném lỗi nào khác: đầu vào lạ hoặc schema/transform ném lỗi đều được
 * quy về `VALIDATION_ERROR`. Thông điệp không chứa giá trị người dùng nhập.
 */
export function parseInput<Schema extends ZodTypeAny>(
  schema: Schema,
  input: unknown,
): z.infer<Schema> {
  let parsed: { success: true; data: unknown } | { success: false; error: ZodError } | undefined;

  try {
    const result = schema.safeParse(input, { errorMap: vietnameseErrorMap });
    parsed = result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  } catch (error) {
    // Schema/transform ném lỗi ngoài ZodError: vẫn trả VALIDATION_ERROR, không crash.
    throw createAppError(
      'VALIDATION_ERROR',
      { trường: ROOT_FIELD, 'lý do': 'Dữ liệu nhập chưa hợp lệ', fields: ROOT_FIELD },
      {
        issues: [{ field: ROOT_FIELD, message: 'Dữ liệu nhập chưa hợp lệ' }],
        cause: error,
      },
    );
  }

  if (!parsed.success) {
    throw buildValidationError(parsed.error);
  }
  return parsed.data as z.infer<Schema>;
}
