/**
 * Bảng khai báo từng tool: loại thao tác và nhóm sử dụng.
 *
 * CHỈ LÀ DỮ LIỆU: server hiện không chặn theo nhóm (`ENFORCE_TIERS = false`).
 * Khi cần bật, kiểm ở một chỗ thay vì rải `if` trong từng tool.
 */
import type { Tier } from '../core/types.js';

/** Nhóm sử dụng của tool; `all` dành cho bộ kiểm tra cho phép mọi tool. */
type ToolTier = Exclude<Tier, 'all'>;

/** Loại thao tác của tool: chỉ đọc hoặc có ghi dữ liệu. */
export type ToolKind = 'read' | 'write';

/** Một dòng của bảng khai báo. */
export interface ToolTierEntry {
  readonly kind: ToolKind;
  readonly tier: ToolTier;
}

/** Các tool đang được khai báo (đều là tool đọc dữ liệu). */
export const TOOL_TIERS = {
  ghn_get_order_detail: { kind: 'read', tier: 'free' },
  ghn_get_fee: { kind: 'read', tier: 'free' },
  ghn_get_shops: { kind: 'read', tier: 'free' },
  ghn_get_districts_wards: { kind: 'read', tier: 'free' },
} as const satisfies Readonly<Record<string, ToolTierEntry>>;

/** Cờ thực thi nhóm sử dụng; hiện tắt nên server không chặn tool nào. */
export const ENFORCE_TIERS = false;
