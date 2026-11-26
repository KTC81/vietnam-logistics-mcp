/** Khai báo kiểu cho `scripts/chuan-bi-goi.mjs` (script thuần JS, chạy bằng node). */
export interface BanSaoGoi {
  nguon: string;
  dich: string;
}

export interface IoChayLenh {
  log: (line: string) => void;
  error: (line: string) => void;
}

export const PACKAGE_ROOT: string;
export const BAN_SAO: BanSaoGoi[];
export function chuanBi(packageRoot?: string): BanSaoGoi[];
export function donDep(packageRoot?: string): number;
export function chay(argv: string[], packageRoot?: string, io?: IoChayLenh): number;
