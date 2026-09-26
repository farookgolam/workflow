// One-time setup: creates a customer (organisation) and its first administrator.
//   npm run seed:tenant -- --name "Acme Corp" --email admin@acme.test --displayName "Acme Admin" [--host acme.approvals.example.com]
// The administrator's 6-digit password key comes from SEED_ADMIN_KEY, or a random one is generated and printed once.
// (Everyone else registers themselves at first sign-in; an admin then grants roles on the Users page.)
//
// This is the same operation the global management site performs - both go through provisionTenant.
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { closePool } from '../db/pool';
import { hostSchema, provisionTenant, slugSchema } from '../platform/provision';

const argsSchema = z.object({
  slug: slugSchema.default('main'),
  name: z.string().min(1).max(200),
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
  host: hostSchema.optional(),
});

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      displayName: { type: 'string' },
      host: { type: 'string' },
    },
  });
  const args = argsSchema.parse(values);

  const result = await provisionTenant({
    name: args.name,
    slug: args.slug,
    host: args.host ?? null,
    admin: { email: args.email, displayName: args.displayName },
    adminKey: process.env.SEED_ADMIN_KEY ?? process.env.SEED_ADMIN_PASSWORD,
  });

  console.log(`Organisation "${args.name}" created; administrator ${args.email} (UserId ${result.adminUserId}).`);
  if (result.generatedAdminKey) console.log(`Generated administrator password key (shown once): ${result.generatedAdminKey}`);
}

main()
  .catch((err) => {
    console.error(err instanceof z.ZodError ? err.issues.map((i) => `--${i.path.join('.')}: ${i.message}`).join('\n') : err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
