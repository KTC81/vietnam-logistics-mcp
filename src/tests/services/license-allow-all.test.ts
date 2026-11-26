import { describe, expect, it } from 'vitest';
import type { LicenseChecker } from '../../src/core/types.js';
import { AllowAll } from '../../src/services/license-allow-all.js';

describe('AllowAll', () => {
  it('luôn hợp lệ với tier all, không cần ngữ cảnh', async () => {
    const checker: LicenseChecker = new AllowAll();

    await expect(
      checker.check({ requestId: 'req_123456', logger: { info() {}, warn() {}, error() {} } }),
    ).resolves.toEqual({ valid: true, tier: 'all' });
  });
});
