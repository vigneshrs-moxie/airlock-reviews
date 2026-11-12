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

/** How long after looking at the token file the service waits before it looks again, on a clock that never goes back. */
export const REREAD_MS = 1_000;

/** The token file as the keeper sees it. */
export interface TokenFile {
  /** What identifies the file's current state (its inode, size, modification time and mode), or null when there is none. */
  look(): Promise<string | null>;
  /**
   * The token in the file, and whether its permissions had to be set back to 0600; or why it is not taken (a symbolic
   * link, empty, or not a token).
   */
  read(): Promise<{ token: string; tightened: boolean } | { refused: string }>;
}

/** The pairing token the running service holds, kept in step with the token file without a restart. */
export interface TokenKeeper {
  /**
   * Whether `given` is the token, compared in constant time, after looking at the file when a second has passed since
   * the last look (a match or not), so a replaced token stops working within a second.
   */
  matches(given: string): Promise<boolean>;
  /** The token to make a proof with, after the same look. */
  forProof(): Promise<string>;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();
const same = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));

/**
 * `first` is the token read at start and the look of the file it came from. Whenever a token is checked or a proof is
 * made, the file is looked at (one `stat`) if `REREAD_MS` has passed on `now`, a clock that never goes back; it is read
 * only when its look changed. A look under way is shared, so a flood of requests costs one look a second at most. A
 * file that is not taken leaves the token held in place; each change of the file, and each failure to look, is logged
 * once, never with the token.
 */
export function keepToken(
  first: { token: string; signature: string | null }, file: TokenFile, now: () => number,
  log: (line: string) => void = () => undefined,
): TokenKeeper {
  let token = first.token;
  let signature = first.signature;
  let lastLook = now();
  let looking: Promise<void> | null = null;
  let lastFailure: string | null = null;

  const lookOnce = async (): Promise<void> => {
    const seen = await file.look();
    if (seen !== signature) {
      // The look is kept only once the file was read, so a read that failed is tried again a second later.
      const found = await file.read();
      signature = seen;
      take(found);
    }
    lastFailure = null;
  };

  const take = (found: Awaited<ReturnType<TokenFile['read']>>): void => {
    if ('refused' in found) {
      log(`The token file changed but was not taken (${found.refused}); the token in use is unchanged.`);
      return;
    }
    if (found.tightened) {
      log('The token file could be read by other users; its permissions were set back to 0600.');
      // Setting the mode changed the look; that is not a change of token, so the next look reads it once more and
      // finds the same token.
    }
    if (found.token !== token) {
      token = found.token;
      log('The token file changed; the new token is in use.');
    }
  };

  const refresh = (): Promise<void> => {
    if (looking !== null) return looking;
    if (now() - lastLook < REREAD_MS) return Promise.resolve();
    lastLook = now();
    looking = lookOnce()
      .catch((e: unknown) => {
        const why = e instanceof Error ? e.message : String(e);
        if (why !== lastFailure) log(`The token file could not be checked (${why}); the token in use is unchanged.`);
        lastFailure = why;
      })
      .finally(() => { looking = null; });
    return looking;
  };

  return {
    async matches(given) {
      await refresh();
      return same(given, token);
    },
    async forProof() {
      await refresh();
      return token;
    },
  };
}
