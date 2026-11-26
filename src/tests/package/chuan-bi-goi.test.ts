import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BAN_SAO, PACKAGE_ROOT, chay, chuanBi, donDep } from '../../scripts/chuan-bi-goi.mjs';

const thuMucTam: string[] = [];

// Thư mục tạm nằm TRONG dự án (tests/package) để không ghi file ra ngoài thư mục dự án.
function taoThuMucTam(prefix = '.tmp-goi-'): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(base, prefix));
  thuMucTam.push(dir);
  return dir;
}

afterEach(() => {
  while (thuMucTam.length > 0) {
    const dir = thuMucTam.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Dựng cây giả giống repo: <goc>/README.md, LICENSE (và GHI-CHU-KHAC.md để kiểm KHÔNG sao chép). */
function taoCayGoi(): { gocRepo: string; packageRoot: string } {
  const gocRepo = taoThuMucTam();
  const packageRoot = join(gocRepo, 'src');
  mkdirSync(packageRoot);
  for (const muc of BAN_SAO) {
    writeFileSync(join(gocRepo, muc.nguon), `nội dung gốc của ${muc.nguon}\n`);
  }
  // File ngoài danh sách: KHÔNG được sao chép vào gói.
  writeFileSync(join(gocRepo, 'GHI-CHU-KHAC.md'), 'ghi chú khác\n');
  return { gocRepo, packageRoot };
}

describe('chuan-bi-goi.mjs', () => {
  it('PACKAGE_ROOT tính theo vị trí script (thư mục src/), không theo thư mục làm việc', () => {
    expect(PACKAGE_ROOT).toBe(fileURLToPath(new URL('../../', import.meta.url)));
  });

  it('chuan-bi sao chép đủ hai file, nội dung giống hệt nguồn', () => {
    const { gocRepo, packageRoot } = taoCayGoi();

    const daCap = chuanBi(packageRoot);

    expect(daCap.map((muc) => basename(muc.dich)).sort()).toEqual(
      BAN_SAO.map((muc) => muc.dich).sort(),
    );
    for (const muc of BAN_SAO) {
      expect(readFileSync(join(packageRoot, muc.dich), 'utf8')).toBe(
        readFileSync(join(gocRepo, muc.nguon), 'utf8'),
      );
    }
  });

  it('chuan-bi ghi đè bản sao cũ khác nội dung (bản sao do script sinh ra)', () => {
    const { gocRepo, packageRoot } = taoCayGoi();
    writeFileSync(join(packageRoot, 'README.md'), 'bản cũ\n');

    chuanBi(packageRoot);

    expect(readFileSync(join(packageRoot, 'README.md'), 'utf8')).toBe(
      readFileSync(join(gocRepo, 'README.md'), 'utf8'),
    );
  });

  it('KHÔNG sao chép GHI-CHU-KHAC.md vào gói; don-dep không động vào file cùng tên có sẵn', () => {
    const { gocRepo, packageRoot } = taoCayGoi();

    chuanBi(packageRoot);
    expect(existsSync(join(packageRoot, 'GHI-CHU-KHAC.md'))).toBe(false);

    // File đặt sẵn trong thư mục gói (không phải bản sao do script tạo) phải được giữ nguyên.
    writeFileSync(
      join(packageRoot, 'GHI-CHU-KHAC.md'),
      readFileSync(join(gocRepo, 'GHI-CHU-KHAC.md'), 'utf8'),
    );
    donDep(packageRoot);
    expect(existsSync(join(packageRoot, 'GHI-CHU-KHAC.md'))).toBe(true);
  });

  it('thông báo chuan-bi chỉ in tên file ngắn, không lộ đường dẫn tuyệt đối', () => {
    const { gocRepo, packageRoot } = taoCayGoi();
    const dong: string[] = [];

    const maThoat = chay(['chuan-bi'], packageRoot, {
      log: (line) => dong.push(line),
      error: () => {},
    });

    expect(maThoat).toBe(0);
    const text = dong.join('\n');
    expect(text).toContain('README.md, LICENSE');
    expect(text).not.toContain('GHI-CHU-KHAC');
    expect(text).not.toContain(gocRepo);
    expect(text).not.toContain(packageRoot);
  });

  it('thiếu file nguồn: lỗi tiếng Việt, không sao chép dở dang', () => {
    const { gocRepo, packageRoot } = taoCayGoi();
    rmSync(join(gocRepo, 'LICENSE'));

    const loi: string[] = [];
    const maThoat = chay(['chuan-bi'], packageRoot, {
      log: () => {},
      error: (line) => loi.push(line),
    });

    expect(maThoat).toBe(1);
    expect(loi.join('\n')).toContain('Thiếu file nguồn');
    expect(loi.join('\n')).toContain('LICENSE');
    // Kiểm nguồn trước khi ghi: không file nào được tạo.
    for (const muc of BAN_SAO) {
      expect(() => readFileSync(join(packageRoot, muc.dich))).toThrow();
    }
  });

  it('don-dep chỉ xóa đúng hai bản sao, không xóa file khác trong thư mục gói', () => {
    const { packageRoot } = taoCayGoi();
    chuanBi(packageRoot);
    mkdirSync(join(packageRoot, 'dist'));
    writeFileSync(join(packageRoot, 'dist', 'index.js'), 'mã\n');
    writeFileSync(join(packageRoot, 'ghi-chu.md'), 'ghi chú nội bộ\n');
    writeFileSync(join(packageRoot, 'package.json'), '{}\n');

    const soDaXoa = donDep(packageRoot);

    expect(soDaXoa).toBe(BAN_SAO.length);
    for (const muc of BAN_SAO) {
      expect(() => readFileSync(join(packageRoot, muc.dich))).toThrow();
    }
    expect(readFileSync(join(packageRoot, 'ghi-chu.md'), 'utf8')).toBe('ghi chú nội bộ\n');
    expect(readFileSync(join(packageRoot, 'package.json'), 'utf8')).toBe('{}\n');
    expect(readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8')).toBe('mã\n');
  });

  it('don-dep chạy hai lần không lỗi (idempotent)', () => {
    const { packageRoot } = taoCayGoi();
    chuanBi(packageRoot);

    expect(donDep(packageRoot)).toBe(BAN_SAO.length);
    expect(donDep(packageRoot)).toBe(0);

    const loi: string[] = [];
    expect(chay(['don-dep'], packageRoot, { log: () => {}, error: (line) => loi.push(line) })).toBe(
      0,
    );
    expect(loi).toEqual([]);
  });

  it('don-dep không xóa file cùng tên nhưng KHÔNG phải bản sao (an toàn khi trỏ sai thư mục)', () => {
    const { packageRoot } = taoCayGoi();
    // README.md trong thư mục gói là file thật do người dùng tạo, khác nội dung nguồn.
    writeFileSync(join(packageRoot, 'README.md'), 'file thật, không phải bản sao\n');

    expect(donDep(packageRoot)).toBe(0);
    expect(readFileSync(join(packageRoot, 'README.md'), 'utf8')).toBe(
      'file thật, không phải bản sao\n',
    );
  });

  it('lệnh lạ: mã thoát 1 kèm cách dùng tiếng Việt', () => {
    const loi: string[] = [];

    expect(
      chay(['sai-lenh'], taoThuMucTam(), { log: () => {}, error: (line) => loi.push(line) }),
    ).toBe(1);
    expect(loi.join('\n')).toContain('Cách dùng');
  });
});
