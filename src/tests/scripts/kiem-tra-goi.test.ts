import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BAN_SAO, chuanBi } from '../../scripts/chuan-bi-goi.mjs';
import {
  caiDatXuLyTinHieu,
  donDepSauKiemTra,
  kiemTraMaThoatThieuToken,
  taoLenhChayShim,
} from '../../scripts/kiem-tra-goi.mjs';

const TEN_TGZ = 'vietnam-logistics-mcp-0.0.0.tgz';

const thuMucTam: string[] = [];

// Thư mục tạm nằm TRONG dự án (tests/scripts) để không ghi file ra ngoài thư mục dự án.
function taoThuMucTam(prefix = '.tmp-kiem-tra-goi-'): string {
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

/** Cây giả: <goc>/src là thư mục gói, có bản sao README/LICENSE, .tgz của gói và .tgz lạ. */
function taoCayKiemTra(): { packageRoot: string; thuMucCai: string } {
  const goc = taoThuMucTam();
  const packageRoot = join(goc, 'src');
  mkdirSync(packageRoot);
  for (const muc of BAN_SAO) {
    writeFileSync(join(goc, muc.nguon), `nội dung gốc của ${muc.nguon}\n`);
  }
  chuanBi(packageRoot);
  writeFileSync(join(packageRoot, TEN_TGZ), 'tarball giả\n');
  writeFileSync(join(packageRoot, 'goi-khac-1.0.0.tgz'), 'tarball khác\n');
  writeFileSync(join(packageRoot, 'package.json'), '{}\n');

  const thuMucCai = join(goc, 'thu-muc-cai');
  mkdirSync(thuMucCai);
  writeFileSync(join(thuMucCai, 'node_modules.txt'), 'x\n');
  return { packageRoot, thuMucCai };
}

function taoBoXuLy() {
  const emitter = new EventEmitter();
  const daDon: number[] = [];
  const daHuy: number[] = [];
  const thongBao: string[] = [];
  const maThoat: number[] = [];
  const go = caiDatXuLyTinHieu({
    donDep: () => daDon.push(1),
    huyTienTrinhCon: () => daHuy.push(1),
    inThongBao: (line) => thongBao.push(line),
    thoat: (code) => maThoat.push(code),
    emitter,
  });
  return { emitter, daDon, daHuy, thongBao, maThoat, go };
}

describe('donDepSauKiemTra', () => {
  it('xóa thư mục tạm, .tgz của gói và bản sao README/LICENSE; giữ file khác', () => {
    const { packageRoot, thuMucCai } = taoCayKiemTra();

    donDepSauKiemTra({ thuMucTam: thuMucCai, packageRoot });

    expect(existsSync(thuMucCai)).toBe(false);
    expect(existsSync(join(packageRoot, TEN_TGZ))).toBe(false);
    for (const muc of BAN_SAO) {
      expect(existsSync(join(packageRoot, muc.dich))).toBe(false);
    }
    expect(existsSync(join(packageRoot, 'goi-khac-1.0.0.tgz'))).toBe(true);
    expect(readFileSync(join(packageRoot, 'package.json'), 'utf8')).toBe('{}\n');
  });

  it('gọi hai lần không lỗi (dọn idempotent)', () => {
    const { packageRoot, thuMucCai } = taoCayKiemTra();

    donDepSauKiemTra({ thuMucTam: thuMucCai, packageRoot });
    expect(() => donDepSauKiemTra({ thuMucTam: thuMucCai, packageRoot })).not.toThrow();
  });
});

describe('caiDatXuLyTinHieu', () => {
  it('SIGINT: hủy tiến trình con, dọn một lần, in thông báo, thoát 130', () => {
    const bo = taoBoXuLy();

    bo.emitter.emit('SIGINT');

    expect(bo.daHuy).toHaveLength(1);
    expect(bo.daDon).toHaveLength(1);
    expect(bo.thongBao).toEqual(['Đã ngắt, đã dọn dẹp']);
    expect(bo.maThoat).toEqual([130]);

    bo.go();
    expect(bo.emitter.listenerCount('SIGINT')).toBe(0);
    expect(bo.emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('SIGTERM: thoát 143, cũng dọn và in thông báo', () => {
    const bo = taoBoXuLy();

    bo.emitter.emit('SIGTERM');

    expect(bo.daHuy).toHaveLength(1);
    expect(bo.daDon).toHaveLength(1);
    expect(bo.thongBao).toEqual(['Đã ngắt, đã dọn dẹp']);
    expect(bo.maThoat).toEqual([143]);
  });

  it('nhận cả hai tín hiệu vẫn chỉ dọn MỘT lần', () => {
    const bo = taoBoXuLy();

    bo.emitter.emit('SIGINT');
    bo.emitter.emit('SIGTERM');

    expect(bo.daDon).toHaveLength(1);
    expect(bo.maThoat).toEqual([130, 143]);
  });
});

describe('kiemTraMaThoatThieuToken', () => {
  it('chỉ chấp nhận mã thoát đúng 1; null (bị tín hiệu giết) và mã khác đều không đạt', () => {
    expect(() => kiemTraMaThoatThieuToken(1)).not.toThrow();

    for (const code of [0, 2, 130, null]) {
      expect(() => kiemTraMaThoatThieuToken(code)).toThrow(/mong đợi 1/);
    }
  });
});

describe('taoLenhChayShim', () => {
  it('POSIX: chạy trực tiếp shim, không qua shell (kiểm shebang và quyền chạy)', () => {
    if (process.platform === 'win32') {
      return;
    }
    const shim = '/tmp/thu muc co khoang trang/node_modules/.bin/vietnam-logistics-mcp';

    expect(taoLenhChayShim(shim)).toEqual({ command: shim, args: [], shell: false });
  });
});
