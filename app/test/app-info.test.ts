import { describe, expect, it } from 'vitest';

import { APP_INFO } from '../src/app-info.js';

describe('APP_INFO', () => {
  it('exposes the application name and a semver version', () => {
    expect(APP_INFO.name).toBe('change-detection-store-mcp');
    expect(APP_INFO.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
