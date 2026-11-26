/**
 * Thư viện THUẦN cho script đo hiệu năng: phân tích tham số, thống kê, đánh giá
 * đạt/không đạt và dựng báo cáo Markdown.
 *
 * Không I/O, không console, không đọc biến môi trường — để test được.
 * `do-hieu-nang.mjs` chỉ nối dây, chạy và in kết quả.
 *
 * Quy trình đo: mỗi tool chạy tuần tự `warmup` lần không tính rồi `runs` lần tính,
 * không chờ giữa các lần; điều kiện ĐẠT dùng TRUNG VỊ T_tool, p95 và max chỉ để báo cáo.
 */

/** Ngưỡng (ms) cho trung vị T_tool ở chế độ thật. */
const NGUONG_T_TOOL = Object.freeze({
  ghn_get_order_detail: 500,
  ghn_get_fee: 800,
});

/** Ngưỡng trung vị T_noi_bo khi chạy `--mock` (áp cho cả 3 tool). */
const NGUONG_NOI_BO_MS = 50;

const MAC_DINH = Object.freeze({ runs: 20, warmup: 2 });

/** Cận trên của tham số: chặn giá trị vô lý làm đo kéo dài vô ích. */
const GIOI_HAN = Object.freeze({ runsToiDa: 1000, warmupToiDa: 100 });

/**
 * Thông tin giả cố định cho chế độ `--mock`. Token nằm trong allowlist của máy quét bí mật
 * (`TOKEN-GIA-...`) và KHÔNG BAO GIỜ được in ra báo cáo/stdout.
 */
export const thongTinGiaMock = Object.freeze({
  token: 'TOKEN-GIA-123',
  shopId: 999999,
  orderCode: 'G8A123456789',
});

/** Biến môi trường bắt buộc ở chế độ thật (WEIGHT không bắt buộc: mặc định 500). */
export const BIEN_BAT_BUOC_THAT = Object.freeze([
  'GHN_TOKEN',
  'GHN_SHOP_ID',
  'GHN_ENV',
  'ORDER_CODE',
  'FROM_DISTRICT',
  'TO_DISTRICT',
  'TO_WARD',
]);

/** Mã lỗi an toàn để in báo cáo: chỉ chữ hoa/số/gạch dưới, tối đa 64 ký tự. */
const MA_LOI_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

// Đọc một biến môi trường dạng chuỗi đã trim; thiếu hoặc sai kiểu coi như rỗng.
function docChuoi(env, ten) {
  const value = env[ten];
  return typeof value === 'string' ? value.trim() : '';
}

// Số nguyên không âm (mã quận có thể là 0 ở một số hệ thống; tool sẽ tự kiểm tiếp).
function laSoNguyenKhongAm(value) {
  return /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value));
}

// Số nguyên dương (ShopId, cân nặng).
function laSoNguyenDuong(value) {
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

/**
 * Chuyển lỗi bất kỳ thành mã lỗi an toàn để đưa vào báo cáo.
 * KHÔNG dùng `error.message`: có thể chứa token/mã đơn/nội dung GHN thô.
 */
export function maLoiAnToan(error) {
  if (error !== null && typeof error === 'object') {
    const code = error.code;
    if (typeof code === 'string' && MA_LOI_PATTERN.test(code)) {
      return code;
    }
  }
  return 'INTERNAL_ERROR';
}

// Chuẩn hoá mã lỗi do tool trả về (`payload.error.code`) về dạng an toàn.
function chuanHoaMaLoi(code) {
  return typeof code === 'string' && MA_LOI_PATTERN.test(code) ? code : 'INTERNAL_ERROR';
}

/**
 * Phân tích tham số dòng lệnh (KHÔNG gồm `node` và đường dẫn script).
 * Tham số không hợp lệ: ném `Error` với thông báo tiếng Việt (file chạy in ra stderr).
 */
export function phanTichThamSo(argv) {
  const thamSo = {
    mode: 'real',
    runs: MAC_DINH.runs,
    warmup: MAC_DINH.warmup,
    out: undefined,
    json: false,
    force: false,
  };
  // Cờ đã gặp: lặp lại một cờ là lỗi (không im lặng lấy giá trị cuối).
  const daGap = new Set();

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--mock' || arg === '--json' || arg === '--force') {
      if (daGap.has(arg)) {
        throw new Error(`Cờ bị lặp: ${arg}.`);
      }
      daGap.add(arg);
      if (arg === '--mock') {
        thamSo.mode = 'mock';
      } else if (arg === '--json') {
        thamSo.json = true;
      } else {
        thamSo.force = true;
      }
      index += 1;
      continue;
    }
    if (arg === '--runs' || arg === '--warmup' || arg === '--out') {
      if (daGap.has(arg)) {
        throw new Error(`Cờ bị lặp: ${arg}.`);
      }
      daGap.add(arg);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Tham số ${arg} cần một giá trị.`);
      }
      if (arg === '--runs') {
        if (!laSoNguyenDuong(value) || Number(value) > GIOI_HAN.runsToiDa) {
          throw new Error(`--runs phải từ 1 đến ${GIOI_HAN.runsToiDa}.`);
        }
        thamSo.runs = Number(value);
      } else if (arg === '--warmup') {
        if (!laSoNguyenKhongAm(value) || Number(value) > GIOI_HAN.warmupToiDa) {
          throw new Error(`--warmup phải từ 0 đến ${GIOI_HAN.warmupToiDa}.`);
        }
        thamSo.warmup = Number(value);
      } else {
        thamSo.out = value;
      }
      index += 2;
      continue;
    }
    throw new Error(`Tham số không hợp lệ: ${arg}`);
  }

  return thamSo;
}

/**
 * Thống kê mô tả: n, trung vị, p95, nhỏ nhất, lớn nhất.
 *
 * p95 theo phương pháp XẾP HẠNG GẦN NHẤT (nearest-rank): sắp xếp tăng dần rồi lấy phần tử thứ
 * `ceil(0.95 × n)` (đánh số từ 1). Ví dụ n = 20 → phần tử thứ 19; n = 1 → phần tử thứ 1.
 * Mảng rỗng trả n = 0 và các giá trị null (KHÔNG ném lỗi).
 */
export function tinhThongKe(values) {
  const n = values.length;
  if (n === 0) {
    return { n: 0, median: null, p95: null, min: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const rank = Math.max(1, Math.min(n, Math.ceil(0.95 * n)));
  return { n, median, p95: sorted[rank - 1], min: sorted[0], max: sorted[n - 1] };
}

/**
 * Kết luận của một tool: có lần lỗi nào thì KHÔNG HỢP LỆ và không kết luận
 * đạt/không đạt; ngưỡng null (ghn_get_shops ở chế độ thật) thì chỉ báo cáo.
 */
export function ketLuanTool(muc) {
  if (muc.errorCount > 0) {
    const ma = muc.firstErrorCode ?? 'INTERNAL_ERROR';
    return `KHÔNG HỢP LỆ: có ${muc.errorCount} lần lỗi (mã lỗi đầu tiên: ${ma})`;
  }
  if (muc.threshold === null) {
    return '— (chỉ báo cáo)';
  }
  const median = muc.statsTook.median;
  if (median === null) {
    return 'KHÔNG HỢP LỆ: không có mẫu hợp lệ';
  }
  return median < muc.threshold ? 'ĐẠT' : 'KHÔNG ĐẠT';
}

/**
 * Mã thoát của cả lượt đo: 1 nếu có BẤT KỲ lần lỗi nào
 * (kể cả khi đồng thời có tool KHÔNG ĐẠT), 2 nếu không lỗi nhưng có tool KHÔNG ĐẠT,
 * 0 nếu mọi tool đều ĐẠT (hoặc không có tool nào có ngưỡng).
 */
export function tinhMaThoat(ketQuaDo) {
  let coKhongDat = false;
  for (const muc of ketQuaDo) {
    const ketLuan = ketLuanTool(muc);
    if (ketLuan.startsWith('KHÔNG HỢP LỆ')) {
      return 1;
    }
    if (ketLuan === 'KHÔNG ĐẠT') {
      coKhongDat = true;
    }
  }
  return coKhongDat ? 2 : 0;
}

// Định dạng số cho bảng: null → '—'; số nguyên giữ nguyên; số lẻ làm tròn 1 chữ số.
function dinhDangSo(value) {
  if (value === null) {
    return '—';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function dinhDangNguong(threshold) {
  return threshold === null ? '—' : `< ${threshold}`;
}

function moTaCheDo(mode) {
  return mode === 'mock'
    ? 'mock (T_noi_bo, cổng GHN giả, không mạng)'
    : 'staging (T_tool, gồm thời gian GHN)';
}

/**
 * Dựng báo cáo Markdown từ kết quả đo.
 *
 * CHỈ dùng các trường được allowlist dưới đây. `nguCanhNhayCam` (token, ShopId, mã đơn) nằm
 * trong dữ liệu vào để test an toàn nhưng TUYỆT ĐỐI không được in ra.
 */
export function xayDungBaoCao(duLieu) {
  const lines = [];
  lines.push('# Báo cáo đo hiệu năng', '');
  lines.push(`- Thời điểm: ${duLieu.generatedAt}`);
  lines.push(`- Chế độ: ${moTaCheDo(duLieu.mode)}`);
  lines.push(`- Node: ${duLieu.nodeVersion}`);
  lines.push(`- Hệ điều hành: ${duLieu.os}`);
  lines.push(`- Commit: ${duLieu.commit}`);
  lines.push(`- Số lần đo mỗi tool: ${duLieu.runs} (khởi động không tính: ${duLieu.warmup})`);
  lines.push('', '## T_tool (tookMs server đo)', '');
  lines.push(
    '| Tool | n | Trung vị (ms) | p95 (ms) | Nhỏ nhất (ms) | Lớn nhất (ms) | Ngưỡng (ms) | Kết quả |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const muc of duLieu.tools) {
    const stats = muc.statsTook;
    lines.push(
      `| ${muc.tool} | ${stats.n} | ${dinhDangSo(stats.median)} | ${dinhDangSo(stats.p95)} | ` +
        `${dinhDangSo(stats.min)} | ${dinhDangSo(stats.max)} | ` +
        `${dinhDangNguong(muc.threshold)} | ${ketLuanTool(muc)} |`,
    );
  }
  lines.push('', '## Thời gian khứ hồi (script đo)', '');
  lines.push('| Tool | n | Trung vị (ms) | p95 (ms) | Nhỏ nhất (ms) | Lớn nhất (ms) |');
  lines.push('|---|---|---|---|---|---|');
  for (const muc of duLieu.tools) {
    const stats = muc.statsRoundTrip;
    lines.push(
      `| ${muc.tool} | ${stats.n} | ${dinhDangSo(stats.median)} | ${dinhDangSo(stats.p95)} | ` +
        `${dinhDangSo(stats.min)} | ${dinhDangSo(stats.max)} |`,
    );
  }
  lines.push('', '## Ghi chú', '');
  lines.push('- staging khác production, số đo staging chưa chứng minh production đạt.');
  lines.push('- p95 báo cáo để tham khảo, điều kiện đạt dùng trung vị.');
  return lines.join('\n');
}

/**
 * Kiểm cấu hình chế độ thật từ biến môi trường (không đọc file .env, không in giá trị).
 *
 * Trả `{ missing }` khi thiếu biến; `{ error }` khi GHN_ENV khác `staging` hoặc biến số sai
 * định dạng (thông báo CHỈ nêu tên biến); `{ args }` khi hợp lệ.
 */
export function kiemTraCauHinhThat(env) {
  const missing = [];
  for (const ten of BIEN_BAT_BUOC_THAT) {
    if (docChuoi(env, ten) === '') {
      missing.push(ten);
    }
  }
  if (missing.length > 0) {
    return { missing };
  }

  // So chuỗi GỐC, KHÔNG trim: ' staging' hay 'staging ' không được chấp nhận — chế độ thật
  // chỉ nhận đúng chữ 'staging'.
  const ghnEnvGoc = env.GHN_ENV;
  if (typeof ghnEnvGoc !== 'string' || ghnEnvGoc !== 'staging') {
    return {
      missing: [],
      error: "GHN_ENV phải là đúng chữ 'staging' ở chế độ thật (không đo production).",
    };
  }

  const saiDinhDang = [];
  const shopId = docChuoi(env, 'GHN_SHOP_ID');
  if (!laSoNguyenDuong(shopId)) {
    saiDinhDang.push('GHN_SHOP_ID');
  }
  const fromDistrict = docChuoi(env, 'FROM_DISTRICT');
  if (!laSoNguyenKhongAm(fromDistrict)) {
    saiDinhDang.push('FROM_DISTRICT');
  }
  const toDistrict = docChuoi(env, 'TO_DISTRICT');
  if (!laSoNguyenKhongAm(toDistrict)) {
    saiDinhDang.push('TO_DISTRICT');
  }
  // WEIGHT không bắt buộc: bỏ trống dùng 500.
  const weight = docChuoi(env, 'WEIGHT') === '' ? '500' : docChuoi(env, 'WEIGHT');
  if (!laSoNguyenDuong(weight)) {
    saiDinhDang.push('WEIGHT');
  }
  if (saiDinhDang.length > 0) {
    return {
      missing: [],
      error: `Biến môi trường sai định dạng (chỉ nêu tên): ${saiDinhDang.join(', ')}.`,
    };
  }

  return {
    missing: [],
    args: {
      orderCode: docChuoi(env, 'ORDER_CODE'),
      fromDistrict: Number(fromDistrict),
      toDistrict: Number(toDistrict),
      toWard: docChuoi(env, 'TO_WARD'),
      weight: Number(weight),
    },
  };
}

/**
 * Kế hoạch đo 3 tool theo chế độ. Chế độ `--mock`: ngưỡng T_noi_bo 50 ms cho cả 3 tool;
 * chế độ thật: có ngưỡng cho detail/fee, `ghn_get_shops` không ngưỡng (chỉ báo cáo).
 */
export function taoKeHoachDo(options) {
  const { mode, args } = options ?? {};
  if (mode === 'mock') {
    return [
      {
        tool: 'ghn_get_order_detail',
        args: { order_code: thongTinGiaMock.orderCode },
        threshold: NGUONG_NOI_BO_MS,
      },
      {
        tool: 'ghn_get_fee',
        args: {
          from_district_id: 1442,
          to_district_id: 1442,
          to_ward_code: '20110',
          weight: 500,
        },
        threshold: NGUONG_NOI_BO_MS,
      },
      { tool: 'ghn_get_shops', args: {}, threshold: NGUONG_NOI_BO_MS },
    ];
  }
  if (mode !== 'real' || args === undefined) {
    throw new Error('taoKeHoachDo: chế độ thật cần args (mã đơn, mã quận, mã phường).');
  }
  return [
    {
      tool: 'ghn_get_order_detail',
      args: { order_code: args.orderCode },
      threshold: NGUONG_T_TOOL.ghn_get_order_detail,
    },
    {
      tool: 'ghn_get_fee',
      args: {
        from_district_id: args.fromDistrict,
        to_district_id: args.toDistrict,
        to_ward_code: args.toWard,
        weight: args.weight,
      },
      threshold: NGUONG_T_TOOL.ghn_get_fee,
    },
    { tool: 'ghn_get_shops', args: {}, threshold: null },
  ];
}

/**
 * Cổng GHN giả cho `--mock`: trả tức thì (không timer, không mạng) dữ liệu hợp lệ đúng hình
 * dạng từng tool. Dữ liệu được kiểm bằng chính `responseSchema` của tool — giống nhánh kiểm
 * phản hồi của `createGhnClient` thật, nên T_noi_bo có cả chi phí Zod của pipeline.
 */
export function taoCongGhnGia() {
  const duLieuTheoEndpoint = {
    '/v2/shipping-order/detail': {
      order_code: thongTinGiaMock.orderCode,
      status: 'delivering',
      cod_amount: 150000,
      leadtime: '2026-11-25T10:00:00Z',
      updated_date: '2026-11-22T09:00:00Z',
    },
    '/v2/shipping-order/fee': {
      total: 35000,
      service_fee: 32000,
      insurance_fee: 3000,
    },
    '/v2/shop/all': {
      shops: [
        { _id: 111111, name: 'Shop A', district_id: 1442, ward_code: '20110', status: 1 },
        { _id: 222222, name: 'Shop mới', district_id: 0, ward_code: '', status: 1 },
      ],
    },
  };

  return {
    async request(endpoint, _payload, responseSchema) {
      const duLieu = duLieuTheoEndpoint[endpoint];
      if (duLieu === undefined) {
        throw new Error(`Cổng GHN giả chưa có dữ liệu cho endpoint ${endpoint}`);
      }
      return responseSchema.parse(duLieu);
    },
  };
}

/**
 * Chạy quy trình đo trên một hàm gọi tool bất kỳ (dùng chung cho script và test).
 *
 * `goi(tool, args)` trả `{ ok: true, tookMs }` hoặc `{ ok: false, errorCode }`; ném ngoại lệ
 * cũng bị coi là lần lỗi. Lần lỗi KHÔNG vào thống kê thời gian (đếm riêng, giữ mã lỗi đầu
 * tiên); lần khởi động (warmup) không vào thống kê nhưng lỗi ở warmup vẫn tính là lỗi.
 */
export async function doLuong(options) {
  const { goi, keHoach, runs, warmup } = options;
  const now = options.now ?? (() => performance.now());
  const ketQua = [];

  for (const muc of keHoach) {
    const mauTook = [];
    const mauKhuHoi = [];
    let errorCount = 0;
    let firstErrorCode = null;
    const tongSoLan = warmup + runs;

    for (let lan = 0; lan < tongSoLan; lan += 1) {
      const batDau = now();
      let ketQuaGoi;
      try {
        ketQuaGoi = await goi(muc.tool, muc.args);
      } catch (error) {
        ketQuaGoi = { ok: false, errorCode: maLoiAnToan(error) };
      }
      const ketThuc = now();

      const thanhCong =
        ketQuaGoi !== null &&
        typeof ketQuaGoi === 'object' &&
        ketQuaGoi.ok === true &&
        typeof ketQuaGoi.tookMs === 'number' &&
        Number.isFinite(ketQuaGoi.tookMs);
      if (!thanhCong) {
        errorCount += 1;
        if (firstErrorCode === null) {
          firstErrorCode = chuanHoaMaLoi(ketQuaGoi?.errorCode);
        }
        continue;
      }
      if (lan >= warmup) {
        mauTook.push(ketQuaGoi.tookMs);
        mauKhuHoi.push(ketThuc - batDau);
      }
    }

    ketQua.push({
      tool: muc.tool,
      threshold: muc.threshold ?? null,
      statsTook: tinhThongKe(mauTook),
      statsRoundTrip: tinhThongKe(mauKhuHoi),
      errorCount,
      firstErrorCode,
    });
  }

  return ketQua;
}
