#!/usr/bin/env node
/**
 * Chuẩn bị thư mục gói trước khi `npm pack`/`npm publish`.
 *
 *   node scripts/chuan-bi-goi.mjs chuan-bi   # sao chép README/LICENSE từ gốc repo vào src/
 *   node scripts/chuan-bi-goi.mjs don-dep    # xóa đúng hai bản sao (không xóa gì khác)
 *
 * README.md và LICENSE nằm ở gốc repo (hiển thị đúng trên GitHub/npm), không phải trong thư
 * mục gói `src/`. `prepack` gọi `chuan-bi` để đưa chúng vào gói; `postpack` gọi `don-dep` để
 * dọn. Đường dẫn tính theo vị trí file script (`import.meta.url`), không phụ thuộc thư mục
 * làm việc hiện tại.
 *
 * Chỉ sao chép README.md và LICENSE vào gói.
 *
 * An toàn: nếu thư mục gói trùng gốc repo (nguồn và đích là một), script KHÔNG ghi/xóa gì —
 * tuyệt đối không động tới README/LICENSE gốc.
 */
import { copyFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Thư mục gói: `src/` (script nằm trong `src/scripts/`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Hai bản sao cần đưa vào gói, giữ nguyên tên; nguồn nằm ở gốc repo (một cấp trên `src/`). */
export const BAN_SAO = [
  { nguon: 'README.md', dich: 'README.md' },
  { nguon: 'LICENSE', dich: 'LICENSE' },
];

function duongDanNguon(packageRoot, ten) {
  return resolve(packageRoot, '..', ten);
}

function duongDanDich(packageRoot, ten) {
  return join(resolve(packageRoot), ten);
}

function laFileThuong(duongDan) {
  try {
    return statSync(duongDan).isFile();
  } catch {
    return false;
  }
}

/** Đích có phải bản sao do script tạo (nội dung giống hệt nguồn) không. */
function laBanSao(nguon, dich) {
  if (nguon === dich || !laFileThuong(nguon) || !laFileThuong(dich)) {
    return false;
  }
  try {
    return readFileSync(nguon).equals(readFileSync(dich));
  } catch {
    return false;
  }
}

/**
 * Sao chép đủ hai file từ gốc repo vào thư mục gói.
 * Kiểm TẤT CẢ nguồn trước khi ghi để không để lại trạng thái dở dang.
 * @throws {Error} thông báo tiếng Việt khi thiếu file nguồn.
 */
export function chuanBi(packageRoot = PACKAGE_ROOT) {
  const cap = [];
  for (const muc of BAN_SAO) {
    const nguon = duongDanNguon(packageRoot, muc.nguon);
    const dich = duongDanDich(packageRoot, muc.dich);
    if (nguon === dich) {
      // Gói trùng gốc repo: không có gì để sao chép và không được ghi đè file gốc.
      continue;
    }
    if (!laFileThuong(nguon)) {
      throw new Error(
        `Thiếu file nguồn "${muc.nguon}" ở gốc repo (cần cho gói npm); không tạo được gói.`,
      );
    }
    cap.push({ nguon, dich });
  }

  for (const muc of cap) {
    copyFileSync(muc.nguon, muc.dich);
  }
  return cap;
}

/**
 * Xóa đúng hai bản sao trong thư mục gói. Không lỗi nếu file không có (idempotent),
 * không xóa file nào khác. Chỉ xóa khi nội dung giống hệt nguồn — bảo đảm không xóa
 * nhầm README/LICENSE thật nếu thư mục gói bị trỏ sai.
 * @returns {number} số file đã xóa.
 */
export function donDep(packageRoot = PACKAGE_ROOT) {
  let soDaXoa = 0;
  for (const muc of BAN_SAO) {
    const nguon = duongDanNguon(packageRoot, muc.nguon);
    const dich = duongDanDich(packageRoot, muc.dich);
    if (laBanSao(nguon, dich)) {
      rmSync(dich, { force: true });
      soDaXoa += 1;
    }
  }
  return soDaXoa;
}

/**
 * Chạy một lệnh con và trả mã thoát (0 = thành công, 1 = lỗi), in thông báo tiếng Việt.
 * Tách khỏi `main` để test gọi được với thư mục tạm mà không cần spawn tiến trình.
 */
export function chay(argv, packageRoot = PACKAGE_ROOT, io = console) {
  const lenh = argv[0];
  try {
    if (lenh === 'chuan-bi') {
      const daCap = chuanBi(packageRoot);
      if (daCap.length > 0) {
        // Chỉ in tên tệp: không lộ đường dẫn tuyệt đối của máy dev trong log.
        io.log(`Đã sao chép ${daCap.map((muc) => basename(muc.dich)).join(', ')} vào thư mục gói.`);
      }
      return 0;
    }
    if (lenh === 'don-dep') {
      const soDaXoa = donDep(packageRoot);
      if (soDaXoa > 0) {
        io.log(`Đã dọn ${soDaXoa} bản sao khỏi thư mục gói.`);
      }
      return 0;
    }
    io.error('Cách dùng: node scripts/chuan-bi-goi.mjs <chuan-bi|don-dep>');
    return 1;
  } catch (error) {
    io.error(`Không chuẩn bị được gói: ${error instanceof Error ? error.message : 'lỗi không rõ'}`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  // Thông báo ra stderr: `npm pack --json` dành stdout cho JSON.
  const ioStderr = {
    log: (line) => process.stderr.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
  process.exitCode = chay(process.argv.slice(2), PACKAGE_ROOT, ioStderr);
}
