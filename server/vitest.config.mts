import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    fileParallelism: false, // all files share one SQL Server test database
    testTimeout: 20000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DB_NAME: 'ApprovalFlow_Test',
      STORAGE_DIR: './storage-test',
      SHAREPOINT_MODE: 'dryrun',
      JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
    },
  },
});
