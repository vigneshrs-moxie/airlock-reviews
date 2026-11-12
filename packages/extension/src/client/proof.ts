/**
 * The panel's half of the proof that whatever answers on Airlock's port holds the pairing token: it asks `/hello` with
 * a fresh nonce and checks the reply's proof with its own copy of the token, so the token is never handed to a program
 * that cannot prove it already knows it. The proof is the HMAC-SHA256, in lower-case hex, of `airlock-hello:<nonce>`
 * keyed with the token's characters, the same as the service's `packages/service/src/proof.ts`.
 */

export const NOT_PROVED = "Something else is answering on Airlock's port. The token was not sent.";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** 16 random bytes as 32 lower-case hex characters. */
export function newNonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function helloProof(token: string, nonce: string): Promise<string> {
  const text = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', text.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(`airlock-hello:${nonce}`))));
}

/** Whether `proof` (from a hello asked with `nonce`) shows the service holds `token`. A missing proof never does. */
export async function proves(proof: string | undefined, token: string, nonce: string): Promise<boolean> {
  return proof !== undefined && proof === (await helloProof(token, nonce));
}
