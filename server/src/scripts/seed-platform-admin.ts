// One-time setup of the global management site: creates a global administrator.
//   npm run seed:platform-admin -- --email you@example.com --displayName "Your Name"
// The 6-digit key comes from SEED_PLATFORM_KEY, or a random one is generated and printed once.
// Run it again with --reset-key to give an existing global administrator a new key.
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { hashPassword, passwordKeyProblem } from '../auth/password';
import { closePool } from '../db/pool';
import { unscopedQuery } from '../db/query';
import { randomPasswordKey } from '../platform/provision';
import { normalizeEmail } from '../users/service';

const argsSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(200),
  resetKey: z.boolean().default(false),
});

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      displayName: { type: 'string' },
      'reset-key': { type: 'boolean' },
    },
  });
  const args = argsSchema.parse({ ...values, resetKey: values['reset-key'] ?? false });
  const email = normalizeEmail(args.email);

  const supplied = process.env.SEED_PLATFORM_KEY;
  const key = supplied ?? randomPasswordKey();
  const problem = passwordKeyProblem(key);
  if (problem) throw new Error(`SEED_PLATFORM_KEY: ${problem}`);
  const passwordHash = await hashPassword(key);

  const [existing] = await unscopedQuery<{ PlatformAdminId: number }>(
    'SELECT PlatformAdminId FROM PlatformAdmins WHERE Email = @Email',
    { Email: email },
  );

  if (existing && !args.resetKey) {
    throw new Error(`${email} is already a global administrator. Pass --reset-key to give them a new key.`);
  }

  if (existing) {
    await unscopedQuery(
      `UPDATE PlatformAdmins
          SET PasswordHash = @Hash, PasswordSetAt = SYSUTCDATETIME(), DisplayName = @Name,
              IsActive = 1, FailedLoginCount = 0, LockedUntil = NULL
        WHERE PlatformAdminId = @Id`,
      { Hash: passwordHash, Name: args.displayName.trim(), Id: existing.PlatformAdminId },
    );
    // anyone holding a session with the old key is signed out
    await unscopedQuery('UPDATE PlatformRefreshTokens SET RevokedAt = SYSUTCDATETIME() WHERE PlatformAdminId = @Id AND RevokedAt IS NULL', {
      Id: existing.PlatformAdminId,
    });
    console.log(`Global administrator ${email} updated.`);
  } else {
    await unscopedQuery(
      `INSERT INTO PlatformAdmins (Email, PasswordHash, DisplayName, PasswordSetAt)
       VALUES (@Email, @Hash, @Name, SYSUTCDATETIME())`,
      { Email: email, Hash: passwordHash, Name: args.displayName.trim() },
    );
    console.log(`Global administrator ${email} created.`);
  }
  if (!supplied) console.log(`Generated password key (shown once): ${key}`);
}

main()
  .catch((err) => {
    console.error(err instanceof z.ZodError ? err.issues.map((i) => `--${i.path.join('.')}: ${i.message}`).join('\n') : err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
