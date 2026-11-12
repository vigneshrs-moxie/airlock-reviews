import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The proof that whatever answers `/hello` holds the pairing token, so the panel and `status` can check it before they
 * send the token: the HMAC-SHA256, in lower-case hex, of `airlock-hello:<nonce>` keyed with the token's characters.
 * The nonce is 16 random bytes as 32 lower-case hex characters, new for every ask.
 */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export const helloProof = (token: string, nonce: string): string =>
  createHmac('sha256', token).update(`airlock-hello:${nonce}`).digest('hex');

export const newNonce = (): string => randomBytes(16).toString('hex');

/** How long after reading the token file the service waits before it reads it again. */
export const REREAD_MS = 1_000;

/** The pairing token the running service holds, kept in step with the token file without a restart. */
export interface TokenKeeper {
  /**
   * Whether `given` is the token, compared in constant time. On a mismatch the file is read again, at most once a
   * second however many requests arrive (a request that comes while a read is under way waits for it), and `given` is
   * compared once more. A match never reads the file.
   */
  matches(given: string): Promise<boolean>;
  /** The token to make a proof with: the one held, after reading the file again when a read is allowed. */
  forProof(): Promise<string>;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();
const same = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

/**
 * `read` gives the token in the file, or null when there is none or it is not a token; the token held is kept then.
 * `now` is in milliseconds. The first read is the one that gave `first`, made at the moment this is called.
 */
export function keepToken(first: string, read: () => Promise<string | null>, now: () => number): TokenKeeper {
  let token = first;
  let lastRead = now();
  let reading: Promise<void> | null = null;

  const reread = (): Promise<void> => {
    if (reading !== null) return reading;
    if (now() - lastRead < REREAD_MS) return Promise.resolve();
    lastRead = now();
    reading = read()
      .then((found) => { if (found !== null) token = found; }, () => undefined)
      .finally(() => { reading = null; });
    return reading;
  };

  return {
    async matches(given) {
      if (same(given, token)) return true;
      await reread();
      return same(given, token);
    },
    async forProof() {
      await reread();
      return token;
    },
  };
}
