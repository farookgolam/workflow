// Drops and rebuilds ApprovalFlow_Test from the migrations before each test run.
export default async function setup() {
  process.env.NODE_ENV = 'test';
  process.env.DB_NAME = 'ApprovalFlow_Test';
  process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-test-secret';
  const { migrate } = await import('../src/db/migrate');
  await migrate({ recreate: true, log: () => {} });
}
