import crypto from 'node:crypto';

// OWASP-recommended argon2id baseline: m=19 MiB, t=2, p=1. Uses Node's built-in argon2 (no native addon).
const MEMORY_KIB = 19456;
const PASSES = 2;
const PARALLELISM = 1;

type Argon2Fn = (
  algorithm: string,
  params: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
  cb: (err: Error | null, key: Buffer) => void,
) => void;
const argon2 = (crypto as unknown as { argon2: Argon2Fn }).argon2;

function derive(password: string, salt: Buffer, memory: number, passes: number, parallelism: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      'argon2id',
      { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism, tagLength: 32, memory, passes },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, MEMORY_KIB, PASSES, PARALLELISM);
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(encoded);
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64');
  const actual = await derive(password, Buffer.from(m[4], 'base64'), Number(m[1]), Number(m[2]), Number(m[3]));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** A valid-looking hash nobody knows the password for: invited users, and timing-equalisation on unknown emails. */
export function unusablePasswordHash(): Promise<string> {
  return hashPassword(crypto.randomBytes(32).toString('base64'));
}

/**
 * The "password key": exactly 6 digits, chosen by the user. It is short by design, so the defences are
 * elsewhere: account lock-out after 5 wrong attempts, rate limiting, and refusing the keys everyone tries first.
 */
export function passwordKeyProblem(key: string): string | null {
  if (!/^\d{6}$/.test(key)) return 'The password key must be exactly 6 digits';
  if (/^(\d)\1{5}$/.test(key)) return 'Choose a key that is not the same digit repeated';
  if ('0123456789012345'.includes(key) || '9876543210987654'.includes(key)) return 'Choose a key that is not a simple sequence';
  if (/^(\d\d)\1\1$/.test(key) || /^(\d{3})\1$/.test(key)) return 'Choose a key that is not a repeated pattern';
  return null;
}
