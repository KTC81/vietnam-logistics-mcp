#!/usr/bin/env node
/**
 * Kiểm tra gói npm như người dùng thật, TRƯỚC khi `npm publish`.
 *
 *   npm run kiem-tra-goi
 *
 * Các bước: (1) `npm pack` trong `src/`; (2) cài tarball vào thư mục tạm bằng `npm install`
 * (CẦN MẠNG để kéo phụ thuộc từ registry — đó là chủ đích: kiểm cả phụ thuộc); (3) chạy bin
 * đã cài QUA SHIM `node_modules/.bin/` (kiểm cả shebang và quyền chạy), gửi JSON-RPC
 * initialize/notifications/initialized/tools/list và kiểm 3 tool; (4) chạy lại KHÔNG có
 * `GHN_TOKEN` để kiểm thông báo tiếng Việt và mã thoát đúng 1; (5) dọn thư mục tạm và .tgz.
 *
 * KHÔNG in token. Mọi bước có timeout cứng. Bị ngắt (SIGINT/SIGTERM): kết thúc tiến trình con,
 * dọn dẹp đúng một lần rồi thoát mã 130/143.
 *
 * Chạy được trên macOS/Windows: npm được gọi qua `process.execPath` + `npm_execpath`
 * (npm tự đặt khi chạy bằng `npm run`), tránh vấn đề `npm.cmd`. Bin đã cài được chạy qua shim
 * của npm; trên Windows shim là `.cmd` nên cần shell — đường dẫn được bọc nháy kép (thư mục tạm
 * có thể chứa khoảng trắng), POSIX chạy trực tiếp shim (đúng shebang/quyền chạy).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { donDep } from './chuan-bi-goi.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN_GIA = 'TOKEN-GIA-123';
const TEN_GOI = 'vietnam-logistics-mcp';
const TOOL_MONG_DOI = ['ghn_get_fee', 'ghn_get_order_detail', 'ghn_get_shops'];
const TIMEOUT_NPM_MS = 240_000;
const TIMEOUT_SERVER_MS = 20_000;

/** Tiến trình server đang chạy (nếu có) để handler tín hiệu kết thúc khi bị ngắt. */
let tienTrinhDangChay;

/** Đã dọn dẹp chưa — chống chạy dọn hai lần (finally và handler tín hiệu). */
let daDonDepKiemTra = false;

/** npm an toàn đa nền tảng: ưu tiên npm_execpath (do npm run đặt). */
function timNpm() {
  const execpath = process.env['npm_execpath'];
  if (typeof execpath === 'string' && execpath !== '' && existsSync(execpath)) {
    return { command: process.execPath, args: [execpath] };
  }
  if (process.platform !== 'win32') {
    return { command: 'npm', args: [] };
  }
  return undefined;
}

/** Bỏ các biến npm_config_* và npm_lifecycle_* của tiến trình cha để npm con dùng cấu hình mặc định. */
function envNpmSach() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_config_') || key.startsWith('npm_lifecycle_')) {
      delete env[key];
    }
  }
  return env;
}

function chayNpm(npm, args, cwd) {
  return execFileSync(npm.command, [...npm.args, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: TIMEOUT_NPM_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: envNpmSach(),
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Lấy JSON của `npm pack --json` dù npm có in thêm dòng khác ra stdout. */
function docJsonPack(output) {
  const dau = output.indexOf('[');
  const cuoi = output.lastIndexOf(']');
  if (dau === -1 || cuoi <= dau) {
    throw new Error('Không đọc được JSON của `npm pack --json`.');
  }
  const duLieu = JSON.parse(output.slice(dau, cuoi + 1));
  if (!Array.isArray(duLieu) || duLieu.length === 0 || typeof duLieu[0].filename !== 'string') {
    throw new Error('`npm pack --json` không trả tên tệp .tgz.');
  }
  return {
    filename: duLieu[0].filename,
    soFile: Array.isArray(duLieu[0].files) ? duLieu[0].files.length : 0,
  };
}

/** Env tối thiểu cho tiến trình server: không kế thừa token thật của máy. */
function envServer(coToken) {
  const env = {
    GHN_ENV: 'staging',
    GHN_SHOP_ID: '999999',
  };
  if (coToken) {
    env['GHN_TOKEN'] = TOKEN_GIA;
  }
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Lệnh chạy shim bin đã cài. POSIX: chạy trực tiếp shim (kiểm shebang + quyền chạy).
 * Windows: shim là `.cmd`, bắt buộc shell; bọc đường dẫn trong nháy kép để an toàn với
 * khoảng trắng (Windows không cho phép ký tự `"` trong tên tệp nên không thể lách nháy).
 */
export function taoLenhChayShim(shim) {
  if (process.platform === 'win32') {
    return { command: `"${shim}"`, args: [], shell: true };
  }
  return { command: shim, args: [], shell: false };
}

/**
 * Chạy bin đã cài, gửi các dòng JSON-RPC rồi đóng stdin. Timeout cứng, không để tiến trình mồ côi.
 * Theo dõi tiến trình đang chạy để handler tín hiệu kết thúc được khi bị ngắt.
 */
function chayServer(lenhBin, cwd, env, lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(lenhBin.command, lenhBin.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: lenhBin.shell,
    });
    tienTrinhDangChay = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const ketThuc = () => {
      if (tienTrinhDangChay === child) {
        tienTrinhDangChay = undefined;
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      ketThuc();
      reject(new Error('Tiến trình server không thoát sau thời hạn cho phép.'));
    }, TIMEOUT_SERVER_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      ketThuc();
      reject(new Error(`Không chạy được shim bin đã cài: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ketThuc();
      resolve({ stdout, stderr, code, signal });
    });
    child.stdin.on('error', (error) => {
      if (lines.length > 0) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        ketThuc();
        reject(new Error(`Ghi stdin cho server thất bại: ${error.message}`));
      }
    });

    for (const line of lines) {
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
  });
}

function tinNhanJsonRpc() {
  return [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'kiem-tra-goi', version: '1.0.0' },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ];
}

function inKetQua(buoc, dat, ghiChu) {
  const nhan = dat ? 'ĐẠT' : 'KHÔNG ĐẠT';
  console.log(`[${buoc}] ${nhan}${ghiChu === undefined ? '' : ` — ${ghiChu}`}`);
}

/**
 * Dọn những gì bước kiểm tra có thể đã tạo: thư mục tạm, các tệp .tgz của gói trong `src/`,
 * và các bản sao README/LICENSE do chuan-bi-goi tạo (nếu còn). Chỉ xóa đúng tệp của gói,
 * không đụng tệp khác. An toàn khi gọi nhiều lần.
 */
export function donDepSauKiemTra({ thuMucTam, packageRoot = PACKAGE_ROOT } = {}) {
  if (typeof thuMucTam === 'string' && thuMucTam !== '') {
    rmSync(thuMucTam, { recursive: true, force: true });
  }
  for (const name of readdirSync(packageRoot)) {
    if (name.startsWith(`${TEN_GOI}-`) && name.endsWith('.tgz')) {
      rmSync(join(packageRoot, name), { force: true });
    }
  }
  donDep(packageRoot);
}

/** Kết thúc tiến trình server đang chạy (nếu còn) khi bị ngắt. */
function huyTienTrinhCon() {
  if (tienTrinhDangChay !== undefined) {
    tienTrinhDangChay.kill('SIGKILL');
    tienTrinhDangChay = undefined;
  }
}

/** Chạy dọn đúng một lần dù finally và handler tín hiệu cùng gọi. */
function donDepMotLan(thuMucTam) {
  if (daDonDepKiemTra) {
    return;
  }
  daDonDepKiemTra = true;
  donDepSauKiemTra({ thuMucTam });
}

/**
 * Cài handler SIGINT/SIGTERM: kết thúc tiến trình con, dọn dẹp (một lần), in thông báo và
 * thoát mã 130 (SIGINT) / 143 (SIGTERM). Trả hàm gỡ handler khi kiểm tra xong.
 * Tham số `emitter`/`thoat`/`inThongBao` để test gọi trực tiếp, không đụng tiến trình thật.
 */
export function caiDatXuLyTinHieu(options) {
  const {
    donDep: hamDonDep,
    huyTienTrinhCon: hamHuy = huyTienTrinhCon,
    inThongBao = (line) => console.log(line),
    thoat = (code) => process.exit(code),
    emitter = process,
  } = options;

  let daDon = false;
  const xuLy = (maThoat) => () => {
    try {
      hamHuy();
      if (!daDon) {
        daDon = true;
        hamDonDep();
      }
    } finally {
      inThongBao('Đã ngắt, đã dọn dẹp');
      thoat(maThoat);
    }
  };

  const onInt = xuLy(130);
  const onTerm = xuLy(143);
  emitter.once('SIGINT', onInt);
  emitter.once('SIGTERM', onTerm);

  return () => {
    emitter.removeListener('SIGINT', onInt);
    emitter.removeListener('SIGTERM', onTerm);
  };
}

/** Mã thoát khi thiếu GHN_TOKEN phải đúng 1; null (bị tín hiệu giết) cũng là KHÔNG ĐẠT. */
export function kiemTraMaThoatThieuToken(code) {
  if (code !== 1) {
    throw new Error(`Thiếu GHN_TOKEN nhưng mã thoát là ${String(code)} (mong đợi 1).`);
  }
}

async function kiemTra() {
  const npm = timNpm();
  if (npm === undefined) {
    throw new Error(
      'Không tìm thấy npm an toàn để chạy. Hãy chạy bằng `npm run kiem-tra-goi` (cách này xử lý đúng trên Windows).',
    );
  }

  let thuMucTam;
  const goXuLyTinHieu = caiDatXuLyTinHieu({
    donDep: () => donDepMotLan(thuMucTam),
  });

  try {
    // 1. Đóng gói
    console.log(`[1/5] Đóng gói bằng npm pack trong ${PACKAGE_ROOT} ...`);
    const pack = docJsonPack(chayNpm(npm, ['pack', '--json'], PACKAGE_ROOT));
    const tgz = join(PACKAGE_ROOT, pack.filename);
    if (!existsSync(tgz)) {
      throw new Error(`npm pack báo tạo ${pack.filename} nhưng không thấy tệp.`);
    }
    inKetQua('1/5', true, `${pack.filename} (${pack.soFile} file trong gói)`);

    // 2. Cài vào thư mục tạm (cần mạng)
    console.log('[2/5] Cài tarball vào thư mục tạm (cần mạng để kéo phụ thuộc) ...');
    thuMucTam = mkdtempSync(join(tmpdir(), 'kiem-tra-goi-'));
    chayNpm(npm, ['init', '-y'], thuMucTam);
    chayNpm(npm, ['install', tgz, '--no-save', '--no-audit', '--no-fund'], thuMucTam);
    const goiCai = join(thuMucTam, 'node_modules', TEN_GOI);
    const packageJsonCai = JSON.parse(readFileSync(join(goiCai, 'package.json'), 'utf8'));
    if (packageJsonCai.bin?.[TEN_GOI] !== 'dist/index.js') {
      throw new Error(`bin trong gói cài không trỏ dist/index.js.`);
    }
    const entry = join(goiCai, 'dist', 'index.js');
    if (!existsSync(entry)) {
      throw new Error('Gói cài thiếu dist/index.js.');
    }
    const tenShim = process.platform === 'win32' ? `${TEN_GOI}.cmd` : TEN_GOI;
    const shim = join(thuMucTam, 'node_modules', '.bin', tenShim);
    if (!existsSync(shim)) {
      throw new Error(
        `Không thấy shim bin đã cài (node_modules/.bin/${tenShim}) — bước cài đặt KHÔNG ĐẠT.`,
      );
    }
    inKetQua('2/5', true, `đã cài ${TEN_GOI}@${String(packageJsonCai.version)} (có shim bin)`);

    // 3. Chạy bin đã cài QUA SHIM, gửi JSON-RPC
    console.log(`[3/5] Chạy shim node_modules/.bin/${tenShim} qua stdio và gửi JSON-RPC ...`);
    const lenhBin = taoLenhChayShim(shim);
    const lan1 = await chayServer(lenhBin, thuMucTam, envServer(true), tinNhanJsonRpc());
    if (lan1.code !== 0 || lan1.signal !== null) {
      throw new Error(
        `Server thoát bất thường (mã ${String(lan1.code)}, tín hiệu ${String(lan1.signal)}).`,
      );
    }
    if (lan1.stdout.includes(TOKEN_GIA) || lan1.stderr.includes(TOKEN_GIA)) {
      throw new Error('Phát hiện token giả trong đầu ra — gói bị lộ cấu hình.');
    }
    const dong = lan1.stdout.split('\n').filter((line) => line.trim() !== '');
    const phanHoi = dong.map((line, index) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`Dòng ${index + 1} trên stdout không phải JSON-RPC.`);
      }
      if (message.jsonrpc !== '2.0') {
        throw new Error(`Dòng ${index + 1} trên stdout không có jsonrpc "2.0".`);
      }
      return message;
    });
    const khoiTao = phanHoi.find((message) => message.id === 1);
    if (khoiTao === undefined || khoiTao.result === undefined) {
      throw new Error('Không nhận được phản hồi initialize.');
    }
    const danhSach = phanHoi.find((message) => message.id === 2);
    const tools = danhSach?.result?.tools;
    if (!Array.isArray(tools)) {
      throw new Error('Không nhận được danh sách tool từ tools/list.');
    }
    const tenTool = tools.map((tool) => tool.name).sort();
    if (JSON.stringify(tenTool) !== JSON.stringify(TOOL_MONG_DOI)) {
      throw new Error(
        `tools/list trả [${tenTool.join(', ')}], mong đợi [${TOOL_MONG_DOI.join(', ')}].`,
      );
    }
    inKetQua('3/5', true, `3 tool qua shim, stdout chỉ JSON-RPC, thoát mã 0`);

    // 4. Thiếu GHN_TOKEN: thông báo tiếng Việt chỉ nêu tên biến, mã thoát đúng 1
    console.log('[4/5] Chạy lại không có GHN_TOKEN ...');
    const lan2 = await chayServer(lenhBin, thuMucTam, envServer(false), []);
    kiemTraMaThoatThieuToken(lan2.code);
    if (!lan2.stderr.includes('GHN_TOKEN')) {
      throw new Error('Thông báo thiếu cấu hình không nêu tên biến GHN_TOKEN.');
    }
    if (lan2.stderr.includes('    at ')) {
      throw new Error('Thông báo lỗi lộ stack trace.');
    }
    inKetQua('4/5', true, `mã thoát 1, thông báo nêu GHN_TOKEN, không có stack`);
  } finally {
    // 5. Dọn dẹp kể cả khi lỗi; chạy đúng một lần dù handler tín hiệu đã dọn trước đó.
    goXuLyTinHieu();
    console.log('[5/5] Dọn thư mục tạm và .tgz ...');
    donDepMotLan(thuMucTam);
    inKetQua('5/5', true, 'đã dọn');
  }
}

function chayChinh() {
  return kiemTra()
    .then(() => {
      console.log('KẾT LUẬN: gói đạt kiểm tra cài đặt và chạy thử. Có thể publish.');
      process.exitCode = 0;
    })
    .catch((error) => {
      console.error(
        `KẾT LUẬN: KHÔNG ĐẠT — ${error instanceof Error ? error.message : 'lỗi không rõ'}`,
      );
      process.exitCode = 1;
    });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void chayChinh();
}
