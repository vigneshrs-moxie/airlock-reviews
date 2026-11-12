/**
 * The panel's half of the proof that whatever answers on Airlock's port holds the pairing token: it asks `/hello` with
 * a fresh nonce and checks the reply's proof with its own copy of the token, so the token is never handed to a program
 * that cannot prove it already knows it. The proof is the HMAC-SHA256, in lower-case hex, of `airlock-hello:<port>:<nonce>`
 * keyed with the token's characters, the same as the service's `packages/service/src/proof.ts`. The service names the port
 * it listens on and the panel the port of the address it connects to, so a proof the real service gave on another port
 * (asked for by whatever answers on the panel's port) does not match.
 */

export const NOT_PROVED = "The service could not show that it holds this panel's token, so the token was not sent. "
  + "If you replaced the token, paste the new one. If you did not, another program may be answering on Airlock's port.";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** 16 random bytes as 32 lower-case hex characters. */
export function newNonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function helloProof(token: string, port: string, nonce: string): Promise<string> {
  const text = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', text.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(`airlock-hello:${port}:${nonce}`))));
}

/** The port of an `http://` address as the proof names it: the one written, or 80 when none is. */
export function portOf(address: string): string {
  const url = new URL(address);
  return url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
}

/**
 * Whether `proof` (from a hello asked with `nonce` on `port`) shows the service holds `token`. A missing proof never does,
 * and neither does one that is not the 64 lower-case hexadecimal characters the HMAC gives.
 */
export async function proves(proof: string | undefined, token: string, port: string, nonce: string): Promise<boolean> {
  return proof !== undefined && proof === (await helloProof(token, port, nonce));
}
