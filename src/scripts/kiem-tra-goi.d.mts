/** Khai báo kiểu cho `scripts/kiem-tra-goi.mjs` (script thuần JS, chạy bằng node). */
export interface DonDepSauKiemTraOptions {
  thuMucTam?: string;
  packageRoot?: string;
}

export interface XuLyTinHieuOptions {
  /** Việc dọn dẹp cần chạy đúng một lần khi bị ngắt. */
  donDep: () => void;
  /** Kết thúc tiến trình con đang chạy (nếu còn). */
  huyTienTrinhCon?: () => void;
  inThongBao?: (line: string) => void;
  thoat?: (code: number) => void;
  /** Nguồn sự kiện; mặc định `process` (test truyền EventEmitter giả). */
  emitter?: {
    once: (event: string, listener: () => void) => unknown;
    removeListener: (event: string, listener: () => void) => unknown;
  };
}

export interface LenhChayShim {
  command: string;
  args: string[];
  shell: boolean;
}

export function donDepSauKiemTra(options?: DonDepSauKiemTraOptions): void;
export function caiDatXuLyTinHieu(options: XuLyTinHieuOptions): () => void;
export function kiemTraMaThoatThieuToken(code: number | null): void;
export function taoLenhChayShim(shim: string): LenhChayShim;
