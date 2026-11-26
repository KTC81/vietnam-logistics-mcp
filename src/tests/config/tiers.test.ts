import { describe, expect, it } from 'vitest';
import { ENFORCE_TIERS, TOOL_TIERS } from '../../src/config/tiers.js';

describe('TOOL_TIERS', () => {
  it('khai báo đúng 4 tool đọc dữ liệu', () => {
    expect(TOOL_TIERS).toEqual({
      ghn_get_order_detail: { kind: 'read', tier: 'free' },
      ghn_get_fee: { kind: 'read', tier: 'free' },
      ghn_get_shops: { kind: 'read', tier: 'free' },
      ghn_get_districts_wards: { kind: 'read', tier: 'free' },
    });
    expect(Object.keys(TOOL_TIERS)).toHaveLength(4);
  });

  it('mọi tool khai báo đều là thao tác đọc', () => {
    for (const entry of Object.values(TOOL_TIERS)) {
      expect(entry.kind).toBe('read');
    }
  });

  it('không áp nhóm sử dụng (cờ tắt)', () => {
    expect(ENFORCE_TIERS).toBe(false);
  });
});
