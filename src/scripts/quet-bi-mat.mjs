/**
 * Quét bí mật trong file đã theo dõi bởi git.
 *
 * Chạy tay (từ thư mục `src`): node scripts/quet-bi-mat.mjs
 * - In mỗi phát hiện dạng `<đường dẫn>:<dòng> [<loại>]`, KHÔNG in nội dung file.
 * - Thoát mã 1 nếu có phát hiện (kể cả tên file cấm như .env, *.pem); 0 nếu sạch.
 *
 * GIỚI HẠN ĐÃ CHỌN (ưu tiên ít báo nhầm hơn bắt hết):
 * - KHÔNG bắt token dạng `abc.def` mà đoạn đầu < 24 ký tự, và KHÔNG bắt `api_key=...`.
 * - KHÔNG bắt token đứng sau biểu thức (ví dụ `|| "..."`, `+ "..."`, hay trong template
 *   như `Token: \`${TOKEN}\``): đó là code, không phải bí mật literal.
 * - KHÔNG bắt `TOKEN=` viết hoa toàn bộ: regex phân biệt hoa/thường, chỉ nhận
 *   `GHN_TOKEN`, `Token`, `token`.
 * - KHÔNG quét lịch sử git (chỉ file đang có trong `git ls-files`).
 * - File ĐÃ THEO DÕI luôn được quét, kể cả đường dẫn có `dist/`; chỉ bỏ `node_modules/`,
 *   `dist/`, `.git/` khi quét một thư mục chưa theo dõi (dùng cho test fixture).
 *
 * Thư viện thuần: `findSecrets` nhận danh sách `{ path, content }` và trả
 * `{ path, line, kind }` — test import hàm này.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** File lớn hơn 1 MB bị bỏ qua (không quét). */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Một "giá trị" sau dấu gán/khóa: lấy TỚI khoảng trắng/nháy/phẩy/chấm phẩy/ngoặc.
 * Nhờ vậy `TOKEN-GIA-123456.<token thật>` được so khớp CHÍNH XÁC toàn đoạn và bị báo
 * (regex cũ dừng ở 24 ký tự nên có thể lách allowlist).
 */
const TOKEN_VALUE = '[^\\s"\'`,;)\\]}]+';

/**
 * Giá trị giả được phép sau `GHN_TOKEN=`/`Token:`/`token =` — mỗi mục có lý do:
 * - `TOKEN-GIA...`: neo chặt, tối đa 40 ký tự sau tiền tố (không cho chuỗi thật dài đi sau);
 * - `...`, `xxx`, `<token>`: chỗ điền mẫu trong tài liệu;
 * - `your-token`/`your_token`: hướng dẫn mẫu;
 * - UUID mẫu của `uuidSchema` (dùng trong test và tài liệu), so không phân biệt hoa thường.
 */
const ALLOWED_ASSIGNMENT_VALUES = [
  /^TOKEN-GIA[-A-Z0-9]{0,40}$/,
  // Giá trị mẫu ghi rõ "giá trị giả" trong src/.env.example (false positive đã kiểm).
  /^token-gia-khong-dung-that$/i,
  /^\.{3,}$/,
  /^x{3,}$/i,
  /^<[^<>]+>$/,
  /^your[-_ ]?token$/i,
];

/** UUID mẫu hợp lệ trong test `uuidSchema` và tài liệu — không phải bí mật. */
const ALLOWED_UUIDS = new Set(['3f6c1d2a-9b7e-4c55-8a10-0d2e5b7f9a11']);

// Các mẫu phát hiện. Mỗi mẫu có `groupValue` để lấy giá trị token ra kiểm allowlist.
const RULES = [
  {
    kind: 'ghn_token',
    // Gán token: GHN_TOKEN=..., Token: ..., token = ..., kể cả dạng JSON "GHN_TOKEN": "..."
    regex: new RegExp(`(?:GHN_TOKEN|Token|token)["']?\\s*[:=]\\s*["'\`]?(${TOKEN_VALUE})`, 'g'),
    groupValue: true,
  },
  {
    kind: 'bearer_token',
    // Authorization (JSON/YAML/nháy), kể cả {"token":"Bearer ..."} và chữ hoa/thường.
    regex: new RegExp(
      `(?:Authorization|token|Token)["']?\\s*:\\s*["']?Bearer\\s+(${TOKEN_VALUE})`,
      'gi',
    ),
    groupValue: true,
  },
  {
    kind: 'private_key',
    regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
    groupValue: false,
  },
  {
    kind: 'github_pat',
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    groupValue: false,
  },
  {
    kind: 'github_ghp',
    regex: /\bghp_[A-Za-z0-9]{20,}\b/g,
    groupValue: false,
  },
  {
    kind: 'openai_sk',
    // sk- hiện đại: sk-ant-api03-..., sk-proj-... (dấu gạch dưới/gạch nối)
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    groupValue: false,
  },
];

// Đường dẫn thuộc thư mục sinh cần bỏ khi quét một thư mục CHƯA theo dõi (test fixture).
// File đã theo dõi luôn được quét — không dùng hàm này cho `findSecrets`.
function laThuMucBoQua(ten) {
  return ten === 'node_modules' || ten === 'dist' || ten === '.git';
}

function laGiaTriGia(value) {
  if (ALLOWED_UUIDS.has(value.toLowerCase())) {
    return true;
  }
  return ALLOWED_ASSIGNMENT_VALUES.some((pattern) => pattern.test(value));
}

// Giá trị là BIỂU THỨC CODE/template, không phải literal bí mật (ví dụ process.env.X,
// this.#config.getToken(), `...${TOKEN}` trong chính mã kiểm thử).
function laBieuThucCode(value) {
  return (
    value.includes('${') ||
    value.includes('process.env') ||
    value.startsWith('process.') ||
    value.startsWith('this.')
  );
}

/** Đọc nội dung trông như nhị phân: có byte NUL trong 8 KB đầu. */
export function isProbablyBinary(buffer) {
  const bytes = buffer.subarray(0, 8192);
  for (const byte of bytes) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Tìm bí mật trong danh sách file văn bản.
 * @param {{ path: string, content: string }[]} files
 * @returns {{ path: string, line: number, kind: string }[]} KHÔNG chứa nội dung.
 */
export function findSecrets(files) {
  const findings = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const rule of RULES) {
        rule.regex.lastIndex = 0;
        let match;
        while ((match = rule.regex.exec(line)) !== null) {
          if (rule.groupValue) {
            const value = match[1] ?? '';
            // So CHÍNH XÁC toàn đoạn với allowlist; chỉ báo khi chuỗi đủ dài và trông như
            // literal token (chữ/số/chấm/gạch), bỏ biểu thức code như process.env.X.
            if (
              laGiaTriGia(value) ||
              value.length < 24 ||
              laBieuThucCode(value) ||
              !/^[A-Za-z0-9._-]+$/.test(value)
            ) {
              continue;
            }
          }
          findings.push({ path: file.path, line: index + 1, kind: rule.kind });
          break; // mỗi dòng chỉ báo một lần cho mỗi loại
        }
      }
    }
  }
  return findings;
}

/** Tên file đã theo dõi bị cấm: .env (trừ *.mau/*.example), *.pem/*.key, thư mục secrets/. */
export function findForbiddenTrackedNames(paths) {
  const findings = [];
  for (const path of paths) {
    const chuanHoa = path.split(sep).join('/');
    const name = chuanHoa.slice(chuanHoa.lastIndexOf('/') + 1);
    const laMau = name.endsWith('.mau') || name.endsWith('.example');
    if ((name === '.env' || (name.startsWith('.env.') && !laMau)) && name !== '.env.example') {
      findings.push({ path: chuanHoa, reason: 'file .env' });
      continue;
    }
    if (name.endsWith('.pem') || name.endsWith('.key')) {
      findings.push({ path: chuanHoa, reason: 'khóa riêng' });
      continue;
    }
    if (chuanHoa.startsWith('secrets/') || chuanHoa.includes('/secrets/')) {
      findings.push({ path: chuanHoa, reason: 'thư mục secrets/' });
    }
  }
  return findings;
}

function docFileNeuVanBan(duongDanTuyetDoi, duongDanHienThi) {
  try {
    const stat = statSync(duongDanTuyetDoi);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) {
      return undefined;
    }
    const buffer = readFileSync(duongDanTuyetDoi);
    if (isProbablyBinary(buffer)) {
      return undefined;
    }
    return { path: duongDanHienThi, content: buffer.toString('utf8') };
  } catch (error) {
    // ENOENT: file còn trong git index nhưng đã bị xóa khỏi đĩa — bỏ qua, không làm sập.
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Lấy TÊN mọi file đã theo dõi (không lọc theo loại/kích thước/nhị phân).
 * Dùng để kiểm tên file cấm TRƯỚC khi đọc nội dung — file .pem nhị phân vẫn phải bị báo.
 */
export function collectTrackedNames(root = process.cwd()) {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter((rel) => rel !== '');
}

/**
 * Lấy file ĐÃ THEO DÕI bởi git và đọc nội dung văn bản.
 * Bỏ file > 1 MB, file nhị phân; file đã xóa khỏi đĩa (ENOENT) cũng bỏ qua.
 */
export function collectTrackedFiles(root = process.cwd()) {
  const files = [];
  for (const rel of collectTrackedNames(root)) {
    const file = docFileNeuVanBan(join(root, rel), rel);
    if (file !== undefined) {
      files.push(file);
    }
  }
  return files;
}

/** Quét đệ quy một thư mục (dùng cho test fixture); bỏ node_modules/dist/.git, file lớn, nhị phân. */
export function quetThuMuc(root) {
  const base = resolve(root);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (laThuMucBoQua(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const file = docFileNeuVanBan(full, relative(base, full).split(sep).join('/'));
        if (file !== undefined) {
          files.push(file);
        }
      }
    }
  };
  walk(base);
  return findSecrets(files);
}

function timGocRepo() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function main() {
  const root = timGocRepo();
  const names = collectTrackedNames(root);
  const files = collectTrackedFiles(root);
  const findings = findSecrets(files);
  const forbidden = findForbiddenTrackedNames(names);

  for (const item of findings) {
    console.log(`${item.path}:${item.line} [${item.kind}]`);
  }
  for (const item of forbidden) {
    console.log(`${item.path} [${item.reason}]`);
  }

  if (findings.length === 0 && forbidden.length === 0) {
    console.log(`Sạch: không phát hiện bí mật trong ${files.length} file đã theo dõi.`);
    return 0;
  }
  console.log(`Phát hiện ${findings.length + forbidden.length} mục cần xem.`);
  return 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Không quét được: ${error instanceof Error ? error.message : 'lỗi không rõ'}`);
    process.exitCode = 2;
  }
}
