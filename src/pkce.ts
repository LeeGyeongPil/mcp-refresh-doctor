// PKCE(RFC 7636, OAuth 2.1 필수): 비밀 문자열(verifier)을 만들고 그 SHA-256 해시(challenge)만 먼저 보낸다.
import { createHash, randomBytes } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function createVerifier(): string {
  // 32바이트 → base64url 43자(명세 허용 범위 43~128자)
  return randomToken(32);
}

export function challengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createState(): string {
  return randomToken(16);
}
