import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';

const ISSUER = 'approvalflow';
const AUDIENCE = 'access'; // a customer's user
const PLATFORM_AUDIENCE = 'platform'; // a global administrator - deliberately a different audience,
// so a platform token is rejected by requireAuth and a customer token by requirePlatformAdmin.

export interface AccessClaims {
  userId: number;
  tenantId: number;
  /** Set when a global administrator is acting as this user (support access). */
  impersonatedBy?: number;
}

export function signAccessToken(claims: AccessClaims, ttlMinutes = config.auth.accessTtlMin): string {
  return jwt.sign({ tid: claims.tenantId, ...(claims.impersonatedBy ? { imp: claims.impersonatedBy } : {}) }, config.auth.jwtSecret, {
    algorithm: 'HS256',
    subject: String(claims.userId),
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ttlMinutes * 60,
  });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
    const userId = Number(p.sub);
    const tenantId = Number(p.tid);
    if (!Number.isInteger(userId) || !Number.isInteger(tenantId)) return null;
    const impersonatedBy = Number.isInteger(Number(p.imp)) && p.imp ? Number(p.imp) : undefined;
    return { userId, tenantId, impersonatedBy };
  } catch {
    return null;
  }
}

export interface PlatformClaims {
  platformAdminId: number;
}

export function signPlatformToken(claims: PlatformClaims): string {
  return jwt.sign({}, config.auth.jwtSecret, {
    algorithm: 'HS256',
    subject: String(claims.platformAdminId),
    issuer: ISSUER,
    audience: PLATFORM_AUDIENCE,
    expiresIn: config.auth.accessTtlMin * 60,
  });
}

export function verifyPlatformToken(token: string): PlatformClaims | null {
  try {
    const p = jwt.verify(token, config.auth.jwtSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: PLATFORM_AUDIENCE,
    }) as jwt.JwtPayload;
    const platformAdminId = Number(p.sub);
    return Number.isInteger(platformAdminId) ? { platformAdminId } : null;
  } catch {
    return null;
  }
}

/** Opaque random token: the raw value goes to the client/email, only its SHA-256 is stored. */
export function newOpaqueToken(): { raw: string; hash: Buffer } {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashOpaqueToken(raw) };
}

export function hashOpaqueToken(raw: string): Buffer {
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}
