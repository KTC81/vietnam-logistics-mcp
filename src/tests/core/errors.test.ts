import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  createAppError,
  toAppError,
  toToolErrorResult,
  type CreateAppErrorOptions,
  type ErrorCode,
  type MessageParams,
  type Retryable,
} from '../../src/core/errors.js';

// Liệt kê tên placeholder trong một mẫu thông điệp (độc lập với code lõi để kiểm chéo).
function lietKePlaceholder(template: string): string[] {
  return [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
}

interface MucDanhMuc {
  code: ErrorCode;
  messageVi: string;
  messageEn: string;
  retry: Retryable;
}

// Danh mục chép ĐỘC LẬP từ bảng mã lỗi của sản phẩm, gồm cả dòng GHN_ORDER_NOT_FOUND;
// cột retry theo mục 1.4a. So bằng toBe để phát hiện lệch dù chỉ một ký tự.
// Ghi chú lựa chọn: GHN_SERVER_ERROR ("auto, rồi user") lưu 'auto'; GHN_TIMEOUT (tool đọc,
// ĐỀ XUẤT) lưu 'auto'. Cả hai vẫn cho người dùng thử lại vì retryable = retry !== 'no'.
const DANH_MUC_THEO_API: MucDanhMuc[] = [
  {
    code: 'VALIDATION_ERROR',
    messageVi: 'Dữ liệu nhập chưa đúng: {trường}: {lý do}. Vui lòng sửa rồi thử lại.',
    messageEn: 'Input validation failed: {fields}',
    retry: 'no',
  },
  {
    code: 'CONFIG_MISSING',
    messageVi: 'Thiếu cấu hình {tên biến}. Hãy điền trong cấu hình AI client rồi khởi động lại.',
    messageEn: 'Missing required configuration: {name}',
    retry: 'no',
  },
  {
    code: 'GHN_UNAUTHORIZED',
    messageVi: 'Token GHN hết hạn, lấy token mới tại khachhang.ghn.vn',
    messageEn: 'GHN returned 401: token invalid or expired',
    retry: 'no',
  },
  {
    code: 'GHN_RATE_LIMITED',
    messageVi: 'GHN đang giới hạn tần suất truy cập. Vui lòng thử lại sau ít phút.',
    messageEn: 'GHN returned 429: rate limited',
    retry: 'user',
  },
  {
    code: 'GHN_SERVER_ERROR',
    messageVi: 'GHN đang gặp sự cố. Vui lòng thử lại sau.',
    messageEn: 'GHN returned 5xx after 1 retry',
    retry: 'auto',
  },
  {
    code: 'GHN_TIMEOUT',
    messageVi: 'GHN phản hồi quá chậm. Vui lòng thử lại.',
    messageEn: 'Request to GHN timed out after {ms} ms',
    retry: 'auto',
  },
  {
    code: 'GHN_NETWORK',
    messageVi: 'Không kết nối được tới GHN. Kiểm tra mạng rồi thử lại.',
    messageEn: 'Network error reaching GHN: {errno}',
    retry: 'user',
  },
  {
    code: 'GHN_ORDER_NOT_FOUND',
    messageVi: 'Không tìm thấy đơn {order_code}. Hãy kiểm tra lại mã vận đơn.',
    messageEn: 'Order not found on GHN',
    retry: 'no',
  },
  {
    code: 'GHN_BAD_REQUEST',
    messageVi:
      'GHN từ chối yêu cầu vì dữ liệu chưa hợp lệ. Hãy kiểm tra lại thông tin đơn/địa chỉ.',
    messageEn: 'GHN rejected request: http {status}, code {code}',
    retry: 'no',
  },
  {
    code: 'GHN_UNEXPECTED_RESPONSE',
    messageVi:
      'Dữ liệu GHN trả về không đúng định dạng. Vui lòng báo hỗ trợ kèm mã yêu cầu {requestId}.',
    messageEn: 'GHN response failed schema validation: {path}',
    retry: 'no',
  },
  {
    code: 'INTERNAL_ERROR',
    messageVi:
      'Có lỗi nội bộ. Vui lòng thử lại; nếu lặp lại hãy báo hỗ trợ kèm mã yêu cầu {requestId}.',
    messageEn: 'Unhandled internal error',
    retry: 'user',
  },
];

// Tham số đủ cho mọi biến `{…}` có trong mẫu Việt/Anh của từng mã.
const PARAMS_DAY_DU: Array<{ code: ErrorCode; params: MessageParams }> = [
  {
    code: 'VALIDATION_ERROR',
    params: { trường: 'weight', 'lý do': 'Cân nặng phải lớn hơn 0 (gram)', fields: 'weight' },
  },
  { code: 'CONFIG_MISSING', params: { 'tên biến': 'GHN_TOKEN', name: 'GHN_TOKEN' } },
  { code: 'GHN_UNAUTHORIZED', params: {} },
  { code: 'GHN_RATE_LIMITED', params: {} },
  { code: 'GHN_SERVER_ERROR', params: {} },
  { code: 'GHN_TIMEOUT', params: { ms: 5000 } },
  { code: 'GHN_NETWORK', params: { errno: 'ENOTFOUND' } },
  { code: 'GHN_ORDER_NOT_FOUND', params: { order_code: 'G8A000000' } },
  { code: 'GHN_BAD_REQUEST', params: { status: 400, code: 'ORDER_NOT_EXIST' } },
  { code: 'GHN_UNEXPECTED_RESPONSE', params: { requestId: 'req_0001', path: 'data.status' } },
  { code: 'INTERNAL_ERROR', params: { requestId: 'req_0001' } },
];

// Các dạng requestId phải bị coi là THIẾU (mục 1 của review): rỗng, toàn khoảng trắng, sai kiểu.
const REQUEST_ID_THIEU: Array<{
  nhan: string;
  params: MessageParams;
  options: CreateAppErrorOptions;
}> = [
  { nhan: 'params.requestId rỗng', params: { requestId: '' }, options: {} },
  { nhan: 'params.requestId toàn khoảng trắng', params: { requestId: '   ' }, options: {} },
  { nhan: 'options.requestId rỗng', params: {}, options: { requestId: '' } },
  { nhan: 'options.requestId toàn khoảng trắng', params: {}, options: { requestId: '   ' } },
  { nhan: 'options.requestId xuống dòng và tab', params: {}, options: { requestId: '\t\n' } },
  { nhan: 'params.requestId xuống dòng và tab', params: { requestId: '\t\n' }, options: {} },
  {
    nhan: 'params.requestId là null',
    params: { requestId: null } as unknown as MessageParams,
    options: {},
  },
  { nhan: 'params.requestId không phải chuỗi', params: { requestId: 123 }, options: {} },
  {
    nhan: 'options.requestId sai kiểu (số)',
    params: {},
    options: { requestId: 123 } as unknown as CreateAppErrorOptions,
  },
];

// requestId hợp lệ có khoảng trắng thừa phải được cắt trước khi dùng.
const REQUEST_ID_CAN_CAT: Array<{
  nhan: string;
  params: MessageParams;
  options: CreateAppErrorOptions;
}> = [
  {
    nhan: 'params.requestId có khoảng trắng thừa',
    params: { requestId: ' req_a ' },
    options: {},
  },
  {
    nhan: 'options.requestId có khoảng trắng thừa',
    params: {},
    options: { requestId: ' req_a ' },
  },
];

describe('ERROR_CATALOG', () => {
  it('có đúng bộ mã lỗi', () => {
    const codes = Object.keys(ERROR_CATALOG) as ErrorCode[];

    expect(new Set(codes)).toEqual(new Set(DANH_MUC_THEO_API.map((item) => item.code)));
  });

  it.each(DANH_MUC_THEO_API)(
    '$code khớp nguyên văn thông điệp Việt/Anh và cột retry',
    ({ code, messageVi, messageEn, retry }) => {
      expect(ERROR_CATALOG[code].messageVi).toBe(messageVi);
      expect(ERROR_CATALOG[code].messageEn).toBe(messageEn);
      expect(ERROR_CATALOG[code].retry).toBe(retry);
    },
  );

  it('không có thông điệp nào chứa thông tin hệ thống của máy chạy', () => {
    for (const entry of Object.values(ERROR_CATALOG)) {
      expect(entry.messageVi).not.toContain(' at ');
      expect(entry.messageVi).not.toContain('/Users/');
      expect(entry.messageVi).not.toContain('stack');
    }
  });

  it('mã dùng {requestId} chỉ có thêm placeholder nằm trong danh sách đã biết', () => {
    // Khi thêm mã mới có placeholder lạ đứng cạnh {requestId}, test này phải đỏ để người sửa
    // chủ động cập nhật danh sách (và kiểm lại việc dựng lại bằng params gốc).
    const placeholderKhacDaBiet: Partial<Record<ErrorCode, string[]>> = {
      GHN_UNEXPECTED_RESPONSE: ['path'],
    };

    for (const code of Object.keys(ERROR_CATALOG) as ErrorCode[]) {
      const entry = ERROR_CATALOG[code];
      const names = new Set([
        ...lietKePlaceholder(entry.messageVi),
        ...lietKePlaceholder(entry.messageEn),
      ]);
      if (!names.has('requestId')) {
        continue;
      }
      const conLai = [...names].filter((name) => name !== 'requestId').sort();
      expect(conLai, `mã ${code} có placeholder lạ ngoài requestId`).toEqual(
        [...(placeholderKhacDaBiet[code] ?? [])].sort(),
      );
    }
  });
});

describe('createAppError', () => {
  it.each(PARAMS_DAY_DU)(
    '$code: truyền đủ tham số thì thông điệp không còn placeholder "{"',
    ({ code, params }) => {
      const error = createAppError(code, params);

      expect(error.messageVi).not.toContain('{');
      expect(error.messageEn).not.toContain('{');
    },
  );

  it('thiếu tham số là lỗi lập trình, không trả thông điệp có placeholder', () => {
    expect(() => createAppError('GHN_ORDER_NOT_FOUND')).toThrow(
      'createAppError: missing placeholders for GHN_ORDER_NOT_FOUND: order_code',
    );
  });

  it('điền biến vào thông điệp tiếng Việt của GHN_ORDER_NOT_FOUND', () => {
    const error = createAppError('GHN_ORDER_NOT_FOUND', { order_code: 'G8A000000' });

    expect(error.messageVi).toBe('Không tìm thấy đơn G8A000000. Hãy kiểm tra lại mã vận đơn.');
  });

  it('điền biến dạng số vào thông điệp tiếng Anh cho log', () => {
    const error = createAppError('GHN_BAD_REQUEST', { status: 400, code: 'ORDER_NOT_EXIST' });

    expect(error.messageEn).toBe('GHN rejected request: http 400, code ORDER_NOT_EXIST');
  });

  it('điền được biến {ms} của GHN_TIMEOUT', () => {
    const error = createAppError('GHN_TIMEOUT', { ms: 5000 });

    expect(error.messageEn).toBe('Request to GHN timed out after 5000 ms');
  });

  it('VALIDATION_ERROR điền trường/lý do và giữ danh sách issues', () => {
    const issue = { field: 'weight', message: 'Cân nặng phải lớn hơn 0 (gram)' };
    const error = createAppError(
      'VALIDATION_ERROR',
      { trường: issue.field, 'lý do': issue.message, fields: issue.field },
      { issues: [issue] },
    );

    expect(error.messageVi).toBe(
      'Dữ liệu nhập chưa đúng: weight: Cân nặng phải lớn hơn 0 (gram). Vui lòng sửa rồi thử lại.',
    );
    expect(error.messageEn).toBe('Input validation failed: weight');
    expect(error.issues).toEqual([issue]);
  });

  it('CONFIG_MISSING chỉ nêu tên biến', () => {
    const error = createAppError('CONFIG_MISSING', {
      'tên biến': 'GHN_TOKEN',
      name: 'GHN_TOKEN',
    });

    expect(error.messageVi).toBe(
      'Thiếu cấu hình GHN_TOKEN. Hãy điền trong cấu hình AI client rồi khởi động lại.',
    );
    expect(error.retryable).toBe(false);
  });

  it('error.message là messageEn (tầng dev), không phải tiếng Việt', () => {
    const error = createAppError('GHN_UNAUTHORIZED');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('GHN returned 401: token invalid or expired');
    expect(error.messageVi).not.toBe(error.message);
  });

  it('retryable là false chỉ khi retry là "no"', () => {
    expect(createAppError('GHN_UNAUTHORIZED').retryable).toBe(false);
    expect(createAppError('GHN_RATE_LIMITED').retryable).toBe(true);
    expect(createAppError('GHN_SERVER_ERROR').retryable).toBe(true);
    expect(createAppError('INTERNAL_ERROR', { requestId: 'req_0001' }).retryable).toBe(true);
  });
});

describe('requestId là khóa hệ thống', () => {
  it('INTERNAL_ERROR thiếu requestId không ném, dùng req_unknown và đánh dấu pending', () => {
    const error = createAppError('INTERNAL_ERROR');

    expect(error.requestIdPending).toBe(true);
    expect(error.messageVi).toContain('req_unknown');
  });

  it.each(REQUEST_ID_THIEU)('$nhan được coi là thiếu: req_unknown và pending', (truongHop) => {
    const error = createAppError('INTERNAL_ERROR', truongHop.params, truongHop.options);

    expect(error.requestIdPending).toBe(true);
    expect(error.messageVi).toContain('req_unknown');
  });

  it.each(REQUEST_ID_CAN_CAT)('$nhan được cắt khoảng trắng trước khi dùng', (truongHop) => {
    const error = createAppError('INTERNAL_ERROR', truongHop.params, truongHop.options);

    expect(error.requestIdPending).toBe(false);
    expect(error.messageVi).toContain('req_a');
    expect(error.messageVi).not.toContain(' req_a ');
  });

  it('options.requestId được dùng và bỏ đánh dấu pending', () => {
    const error = createAppError('INTERNAL_ERROR', {}, { requestId: 'req_options' });

    expect(error.requestIdPending).toBe(false);
    expect(error.messageVi).toContain('req_options');
    expect(error.messageVi).not.toContain('req_unknown');
  });

  it('params.requestId được ưu tiên hơn options.requestId', () => {
    const error = createAppError(
      'INTERNAL_ERROR',
      { requestId: 'req_params' },
      { requestId: 'req_options' },
    );

    expect(error.requestIdPending).toBe(false);
    expect(error.messageVi).toContain('req_params');
    expect(error.messageVi).not.toContain('req_options');
  });

  it('mã không dùng {requestId} không bị đánh dấu pending', () => {
    expect(createAppError('GHN_UNAUTHORIZED').requestIdPending).toBe(false);
  });

  it('placeholder khác requestId thiếu vẫn ném lỗi lập trình', () => {
    expect(() => createAppError('GHN_UNEXPECTED_RESPONSE')).toThrow(
      'createAppError: missing placeholders for GHN_UNEXPECTED_RESPONSE: path',
    );
  });

  it('toToolErrorResult dựng lại lỗi pending bằng requestId thật, không lộ trường nội bộ', () => {
    const pending = createAppError('GHN_UNEXPECTED_RESPONSE', { path: 'data.status' });
    expect(pending.requestIdPending).toBe(true);
    expect(pending.messageVi).toContain('req_unknown');

    const result = toToolErrorResult(pending, 'req_0002');

    expect(result.error.message).toContain('req_0002');
    expect(result.error.message).not.toContain('req_unknown');
    expect(result.error.message).not.toContain('{');
    expect(result.meta.requestId).toBe('req_0002');
    expect(result.error).not.toHaveProperty('requestIdPending');
    expect(JSON.stringify(result)).not.toContain('requestIdPending');
  });

  it('toToolErrorResult dựng lại INTERNAL_ERROR pending bằng requestId thật', () => {
    const result = toToolErrorResult(createAppError('INTERNAL_ERROR'), 'req_0003');

    expect(result.error.message).toContain('req_0003');
    expect(result.error.message).not.toContain('req_unknown');
    expect(result.meta.requestId).toBe('req_0003');
  });
});

describe('withRequestId', () => {
  it('giữ nguyên stack của bản gốc, kết quả tool chỉ có đúng các khóa cho phép', () => {
    const pending = createAppError('INTERNAL_ERROR');
    const stackGoc = pending.stack;
    expect(stackGoc).toBeDefined();

    const rebuilt = pending.withRequestId('req_0005');
    expect(rebuilt.stack).toBe(stackGoc);

    const result = toToolErrorResult(pending, 'req_0005');
    expect(Object.keys(result).sort()).toEqual(['error', 'meta', 'ok']);
    expect(Object.keys(result.error).sort()).toEqual(['code', 'message', 'retryable']);
    expect(Object.keys(result.meta)).toEqual(['requestId']);
    expect(JSON.stringify(result)).not.toContain('stack');

    // VALIDATION_ERROR có issues: chỉ thêm đúng khóa 'issues', không có khóa lạ.
    const issue = { field: 'weight', message: 'Cân nặng phải lớn hơn 0 (gram)' };
    const validation = createAppError(
      'VALIDATION_ERROR',
      { trường: 'weight', 'lý do': issue.message, fields: 'weight' },
      { issues: [issue] },
    );
    const validationResult = toToolErrorResult(validation, 'req_0006');
    expect(Object.keys(validationResult).sort()).toEqual(['error', 'meta', 'ok']);
    expect(Object.keys(validationResult.error).sort()).toEqual([
      'code',
      'issues',
      'message',
      'retryable',
    ]);
    expect(Object.keys(validationResult.meta)).toEqual(['requestId']);
    expect(JSON.stringify(validationResult)).not.toContain('stack');
  });

  it('dựng lại đủ trường cho GHN_UNEXPECTED_RESPONSE (có {path} ở messageEn)', () => {
    const cause = new Error('nguyen-nhan-goc');
    const issues = [{ field: 'path', message: 'lỗi mẫu' }];
    const pending = createAppError(
      'GHN_UNEXPECTED_RESPONSE',
      { path: 'data.status' },
      { cause, issues },
    );
    expect(pending.requestIdPending).toBe(true);

    const rebuilt = pending.withRequestId('req_x');

    expect(rebuilt.messageVi).toContain('req_x');
    expect(rebuilt.messageEn).toContain('data.status');
    expect(rebuilt.code).toBe('GHN_UNEXPECTED_RESPONSE');
    expect(rebuilt.retry).toBe('no');
    expect(rebuilt.cause).toBe(cause);
    expect(rebuilt.issues).toEqual(issues);
    expect(rebuilt.requestIdPending).toBe(false);
  });

  it('tham số path chứa chuỗi {requestId} không bị thay lượt hai', () => {
    const pending = createAppError('GHN_UNEXPECTED_RESPONSE', { path: '{requestId}' });
    expect(pending.requestIdPending).toBe(true);

    const rebuilt = pending.withRequestId('req_that');
    expect(rebuilt.messageVi).toContain('req_that');
    expect(rebuilt.messageEn).toBe('GHN response failed schema validation: {requestId}');

    const result = toToolErrorResult(pending, 'req_that');
    expect(result.error.message).toContain('req_that');
    expect(result.error.message).not.toContain('req_unknown');
    // toToolErrorResult không sửa bản gốc.
    expect(pending.messageEn).toBe('GHN response failed schema validation: {requestId}');
  });
});

describe('toAppError', () => {
  it('trả nguyên AppError nếu đã là AppError', () => {
    const original = createAppError('GHN_NETWORK', { errno: 'ENOTFOUND' });

    expect(toAppError(original)).toBe(original);
  });

  it('đổi lỗi lạ thành INTERNAL_ERROR, giữ cause nhưng không lộ thông điệp gốc', () => {
    const raw = new Error('lỗi gốc bí mật tại /duong/dan/may');
    const error = toAppError(raw);

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.cause).toBe(raw);
    expect(error.messageEn).toBe('Unhandled internal error');
    expect(error.messageVi).not.toContain('lỗi gốc bí mật');
    expect(error.messageVi).not.toContain('/duong/dan/may');
    expect(error.messageVi).not.toContain('{');
    expect(error.requestIdPending).toBe(true);
    expect(error.messageVi).toContain('req_unknown');
  });

  it('truyền requestId sang options để thông điệp có mã thật ngay từ đầu', () => {
    const raw = new Error('lỗi gốc');
    const error = toAppError(raw, 'req_real_0001');

    expect(error.requestIdPending).toBe(false);
    expect(error.messageVi).toContain('req_real_0001');
    expect(error.messageVi).not.toContain('req_unknown');
  });

  it('nhận cả giá trị không phải Error', () => {
    const error = toAppError('chuỗi lỗi lạ');

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.messageVi).toContain('Có lỗi nội bộ');
    expect(error.cause).toBe('chuỗi lỗi lạ');
  });
});

describe('toToolErrorResult', () => {
  it('trả đúng dạng lỗi, không có messageEn', () => {
    const result = toToolErrorResult(createAppError('GHN_UNAUTHORIZED'), 'req_7f3a9c');

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'GHN_UNAUTHORIZED',
        message: 'Token GHN hết hạn, lấy token mới tại khachhang.ghn.vn',
        retryable: false,
      },
      meta: { requestId: 'req_7f3a9c' },
    });
    expect(result.error).not.toHaveProperty('messageEn');
  });

  it.each(['', '  ', '\t\n'])(
    'requestId %j không hợp lệ: lỗi pending dùng req_unknown cho cả message và meta',
    (requestId) => {
      const result = toToolErrorResult(createAppError('INTERNAL_ERROR'), requestId);

      expect(result.meta.requestId).toBe('req_unknown');
      expect(result.error.message).toContain('req_unknown');
    },
  );

  it.each(['', '  '])(
    'requestId %j không hợp lệ: lỗi không pending (VALIDATION_ERROR) cũng đồng bộ meta',
    (requestId) => {
      const issue = { field: 'weight', message: 'Cân nặng phải lớn hơn 0 (gram)' };
      const validation = createAppError(
        'VALIDATION_ERROR',
        { trường: 'weight', 'lý do': issue.message, fields: 'weight' },
        { issues: [issue] },
      );

      const result = toToolErrorResult(validation, requestId);

      expect(result.meta.requestId).toBe('req_unknown');
      expect(result.error.issues).toEqual([issue]);
      expect(result.error.message).not.toContain('{');
      // VALIDATION_ERROR không dùng {requestId} nên req_unknown không bị nhét vào message.
      expect(result.error.message).not.toContain('req_unknown');
    },
  );

  it('requestId có khoảng trắng thừa được cắt cho cả message và meta', () => {
    const result = toToolErrorResult(createAppError('INTERNAL_ERROR'), ' req_a ');

    expect(result.meta.requestId).toBe('req_a');
    expect(result.error.message).toContain('req_a');
    expect(result.error.message).not.toContain(' req_a ');
  });

  it('requestId hợp lệ giữ nguyên ở cả lỗi pending và không pending', () => {
    const pending = createAppError('INTERNAL_ERROR');
    expect(toToolErrorResult(pending, 'req_pending').meta.requestId).toBe('req_pending');

    const issue = { field: 'weight', message: 'Cân nặng phải lớn hơn 0 (gram)' };
    const validation = createAppError(
      'VALIDATION_ERROR',
      { trường: 'weight', 'lý do': issue.message, fields: 'weight' },
      { issues: [issue] },
    );
    expect(toToolErrorResult(validation, 'req_validation').meta.requestId).toBe('req_validation');
  });

  it('chỉ có issues khi VALIDATION_ERROR', () => {
    const issue = { field: 'weight', message: 'Cân nặng phải lớn hơn 0 (gram)' };
    const validation = toToolErrorResult(
      createAppError(
        'VALIDATION_ERROR',
        { trường: 'weight', 'lý do': issue.message, fields: 'weight' },
        { issues: [issue] },
      ),
      'req_0001',
    );
    const other = toToolErrorResult(
      createAppError('INTERNAL_ERROR', { requestId: 'req_0001' }, { issues: [issue] }),
      'req_0001',
    );

    expect(validation.error.issues).toEqual([issue]);
    expect(other.error).not.toHaveProperty('issues');
  });

  it('điền {requestId} cho lỗi nội bộ ở bước trả kết quả', () => {
    const result = toToolErrorResult(new Error('boom'), 'req_123');

    expect(result.error.message).toBe(
      'Có lỗi nội bộ. Vui lòng thử lại; nếu lặp lại hãy báo hỗ trợ kèm mã yêu cầu req_123.',
    );
  });

  it('không thay lần hai: tham số người dùng chứa chuỗi "{requestId}" được giữ nguyên', () => {
    const error = createAppError('GHN_ORDER_NOT_FOUND', { order_code: '{requestId}' });
    expect(error.messageVi).toContain('{requestId}');

    const result = toToolErrorResult(error, 'req_0001');

    expect(result.error.message).toContain('{requestId}');
    expect(result.error.message).not.toContain('req_0001');
  });

  it('không lộ stack hay thông điệp gốc của lỗi', () => {
    const result = toToolErrorResult(new Error('lỗi gốc bí mật'), 'req_0001');
    const json = JSON.stringify(result);

    expect(json).not.toContain('lỗi gốc bí mật');
    expect(json).not.toContain('stack');
    expect(json).not.toContain('.ts:');
  });

  it('không lộ cause bí mật của lỗi pending sau khi dựng lại', () => {
    const cause = new Error('bi-mat-cause');
    const pending = createAppError('INTERNAL_ERROR', {}, { cause });
    const result = toToolErrorResult(pending, 'req_0004');
    const json = JSON.stringify(result);

    expect(json).not.toContain('bi-mat-cause');
    expect(json).not.toContain('stack');
  });
});
