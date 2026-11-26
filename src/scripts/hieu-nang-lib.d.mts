/** Khai báo kiểu cho `scripts/hieu-nang-lib.mjs` (thư viện thuần JS, test TS import). */
import type { GhnGateway } from '../src/core/types.js';

export interface ThongKe {
  n: number;
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

export type CheDo = 'mock' | 'real';

export interface ThamSoDo {
  mode: CheDo;
  runs: number;
  warmup: number;
  out: string | undefined;
  json: boolean;
  force: boolean;
}

export interface MucKeHoach {
  tool: string;
  args: Readonly<Record<string, unknown>>;
  threshold: number | null;
}

export interface KetQuaToolDo {
  tool: string;
  threshold: number | null;
  statsTook: ThongKe;
  statsRoundTrip: ThongKe;
  errorCount: number;
  firstErrorCode: string | null;
}

export interface NguCanhNhayCam {
  token?: string;
  shopId?: number;
  orderCode?: string;
}

export interface DuLieuBaoCao {
  mode: CheDo;
  generatedAt: string;
  nodeVersion: string;
  os: string;
  commit: string;
  runs: number;
  warmup: number;
  tools: readonly KetQuaToolDo[];
  /** Ngữ cảnh nhạy cảm: báo cáo KHÔNG được đưa các trường này vào (chỉ để test an toàn). */
  nguCanhNhayCam?: NguCanhNhayCam;
}

export interface CaiDatThat {
  orderCode: string;
  fromDistrict: number;
  toDistrict: number;
  toWard: string;
  weight: number;
}

export interface KetQuaCauHinhThat {
  missing: string[];
  error?: string;
  args?: CaiDatThat;
}

export interface KetQuaGoiTool {
  ok: boolean;
  tookMs?: number;
  errorCode?: string;
}

export type HamGoiTool = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<KetQuaGoiTool>;

export const thongTinGiaMock: Readonly<{
  token: string;
  shopId: number;
  orderCode: string;
}>;

export const BIEN_BAT_BUOC_THAT: readonly string[];

export function maLoiAnToan(error: unknown): string;

export function phanTichThamSo(argv: readonly string[]): ThamSoDo;

export function tinhThongKe(values: readonly number[]): ThongKe;

export function ketLuanTool(muc: KetQuaToolDo): string;

export function tinhMaThoat(ketQuaDo: readonly KetQuaToolDo[]): number;

export function xayDungBaoCao(duLieu: DuLieuBaoCao): string;

export function kiemTraCauHinhThat(
  env: Readonly<Record<string, string | undefined>>,
): KetQuaCauHinhThat;

export function taoKeHoachDo(options: { mode: CheDo; args?: CaiDatThat }): MucKeHoach[];

export function taoCongGhnGia(): GhnGateway;

export function doLuong(options: {
  goi: HamGoiTool;
  keHoach: readonly MucKeHoach[];
  runs: number;
  warmup: number;
  now?: () => number;
}): Promise<KetQuaToolDo[]>;
