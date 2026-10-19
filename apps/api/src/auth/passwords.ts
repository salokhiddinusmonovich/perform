import { hash, verify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';

// Argon2id with OWASP-recommended parameters (19 MiB, 2 iterations).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Hash of a random password. Verified against when the login doesn't exist, so that
// "unknown user" and "wrong password" take the same time and can't be told apart.
let dummyHash: Promise<string> | undefined;
export function verifyDummyPassword(password: string): Promise<boolean> {
  dummyHash ??= hashPassword(generateTemporaryPassword());
  return dummyHash.then((h) => verifyPassword(h, password));
}

// No look-alike characters (0/O, 1/l/I), so it can be read out or typed from a phone.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One-time password handed to a new user; they must change it at first login. */
export function generateTemporaryPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
