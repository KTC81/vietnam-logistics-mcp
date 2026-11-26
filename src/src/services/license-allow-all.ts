/**
 * Bản `LicenseChecker` mặc định: luôn cho phép, không gọi mạng, không log nội dung.
 *
 * Có thể thay bằng bản kiểm tra khác mà không sửa tool.
 */
import type { LicenseChecker, LicenseVerdict } from '../core/types.js';

export class AllowAll implements LicenseChecker {
  async check(): Promise<LicenseVerdict> {
    return { valid: true, tier: 'all' };
  }
}
