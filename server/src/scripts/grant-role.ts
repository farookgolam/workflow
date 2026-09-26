// Grants (or removes) a role from the command line - for the server operator, e.g. to make your own
// account an administrator when no other administrator is available to do it on the Users page.
//   npm run grant-role -- --email you@example.com --role Admin
//   npm run grant-role -- --email you@example.com --role Admin --remove
// The person must have signed in once (so the account exists). The change is written to the audit log as "System".
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { audit, systemActor } from '../audit/audit';
import { closePool } from '../db/pool';
import { tenantQuery, withTx } from '../db/query';
import { resolveTenantId } from '../tenant';
import { normalizeEmail } from '../users/service';

const argsSchema = z.object({
  email: z.string().email(),
  role: z.enum(['Admin', 'Approver', 'Submitter']),
  remove: z.boolean().default(false),
});

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, role: { type: 'string' }, remove: { type: 'boolean' } } });
  const args = argsSchema.parse(values);
  const tenantId = await resolveTenantId(null);
  const email = normalizeEmail(args.email);

  await withTx(async (tx) => {
    const [user] = await tenantQuery<{ UserId: number; DisplayName: string }>(
      tenantId,
      'SELECT UserId, DisplayName FROM Users WITH (UPDLOCK) WHERE TenantId = @TenantId AND Email = @Email',
      { Email: email },
      tx,
    );
    if (!user) throw new Error(`No account for ${email}. Ask them to sign in once first - that creates the account.`);

    if (args.remove) {
      const left = await tenantQuery<{ Role: string }>(tenantId, 'SELECT Role FROM UserRoles WHERE TenantId = @TenantId AND UserId = @U AND Role <> @Role', { U: user.UserId, Role: args.role }, tx);
      if (!left.length) throw new Error('A user must keep at least one role.');
      if (args.role === 'Admin') {
        const [others] = await tenantQuery<{ n: number }>(
          tenantId,
          `SELECT COUNT(*) AS n FROM UserRoles r JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.UserId
            WHERE r.TenantId = @TenantId AND r.Role = 'Admin' AND u.IsActive = 1 AND r.UserId <> @U`,
          { U: user.UserId },
          tx,
        );
        if (others.n === 0) throw new Error('Refusing to remove the last active administrator.');
      }
      await tenantQuery(tenantId, 'DELETE FROM UserRoles WHERE TenantId = @TenantId AND UserId = @U AND Role = @Role', { U: user.UserId, Role: args.role }, tx);
    } else {
      await tenantQuery(
        tenantId,
        `IF NOT EXISTS (SELECT 1 FROM UserRoles WHERE TenantId = @TenantId AND UserId = @U AND Role = @Role)
           INSERT INTO UserRoles (TenantId, UserId, Role) VALUES (@TenantId, @U, @Role)`,
        { U: user.UserId, Role: args.role },
        tx,
      );
    }
    const roles = (await tenantQuery<{ Role: string }>(tenantId, 'SELECT Role FROM UserRoles WHERE TenantId = @TenantId AND UserId = @U ORDER BY Role', { U: user.UserId }, tx)).map((r) => r.Role);
    await audit(tenantId, systemActor, { action: 'user.updated', entityType: 'User', entityId: user.UserId, detail: { via: 'grant-role CLI', role: args.role, removed: args.remove, roles } }, tx);
    console.log(`${user.DisplayName} <${email}> now has: ${roles.join(', ')}`);
  });
}

main()
  .catch((err) => {
    console.error(err instanceof z.ZodError ? err.issues.map((i) => `--${i.path.join('.')}: ${i.message}`).join('\n') : err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
