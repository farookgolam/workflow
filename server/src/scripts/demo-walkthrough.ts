// DEV ONLY. Drives two sample requests through the demo chain using the engine directly (no HTTP, no passwords):
// one fully approved, one rejected at step 2 - so the PDF archive has something to work on.
//   npm run demo:walkthrough
import { config } from '../config';
import { closePool } from '../db/pool';
import { tenantQuery, unscopedQuery } from '../db/query';
import { decideStep, submitRequest } from '../workflow/engine';

const actor = (userId: number) => ({ userId, ip: '127.0.0.1', userAgent: 'demo-walkthrough' });

async function main() {
  if (config.isProd) throw new Error('demo:walkthrough is disabled in production');
  const [tenant] = await unscopedQuery<{ TenantId: number }>(`SELECT TenantId FROM Tenants WHERE Slug = 'demo'`);
  if (!tenant) throw new Error('Run seed:tenant and seed:demo first');
  const t = tenant.TenantId;
  const users = Object.fromEntries(
    (await tenantQuery<{ UserId: number; Email: string; DisplayName: string }>(t, 'SELECT UserId, Email, DisplayName FROM Users WHERE TenantId = @TenantId')).map((u) => [
      u.Email.split('@')[0],
      { userId: u.UserId, email: u.Email, displayName: u.DisplayName },
    ]),
  );
  const [form] = await tenantQuery<{ FormId: number }>(t, `SELECT FormId FROM Forms WHERE TenantId = @TenantId AND Slug = 'purchase-request'`);

  const run = async (title: string, amount: number, rejectAtFinance: boolean) => {
    const { requestId, requestNumber } = await submitRequest(t, actor(users.submitter.userId), users.submitter, form.FormId, {
      title,
      justification: 'Needed for the Q4 client rollout.\nCurrent equipment is out of warranty.',
      amount,
      category: 'Hardware',
      neededBy: '2026-11-15',
      urgent: true,
    });
    const steps = await tenantQuery<{ RequestStepId: number }>(t, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: requestId });
    await decideStep(t, actor(users.manager.userId), users.manager, steps[0].RequestStepId, { decision: 'approve', comments: 'Team has needed this for a while.' });
    if (rejectAtFinance) {
      await decideStep(t, actor(users.finance.userId), users.finance, steps[1].RequestStepId, { decision: 'reject', comments: 'See reason.', rejectionReason: 'Hardware budget for Q4 is exhausted. Please resubmit in January.' });
    } else {
      await decideStep(t, actor(users.finance.userId), users.finance, steps[1].RequestStepId, { decision: 'approve' });
      await decideStep(t, actor(users.director.userId), users.director, steps[2].RequestStepId, { decision: 'approve', comments: 'Approved.' });
    }
    console.log(`${requestNumber}: ${rejectAtFinance ? 'rejected at step 2' : 'fully approved'}`);
  };
  await run('12 developer laptops', 28800, false);
  await run('Standing desks for the whole floor', 45000, true);
  console.log('Done. The archive worker of the running API will pick these up within ~15 seconds.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
