import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The built extension may name only the service on this Mac and GitHub. Checked on the bundles themselves, so a request
// made any way at all (fetch, an image, a script) would show up; the bundles exist once a build has run (npm run e2e
// makes .output-e2e, the guide's build makes .output).
const BUILDS = ['.output-e2e/chrome-mv3', '.output/chrome-mv3']
  .map((dir) => fileURLToPath(new URL(`../${dir}`, import.meta.url)))
  .filter((dir) => existsSync(dir));

const HOSTS = new Set(['127.0.0.1', 'github.com']);
export const NO_BUILD = 'skipped: no built extension; run npm run e2e first';

/**
 * Addresses with a scheme (http, https, ws, wss), and protocol-relative ones (`//host.tld`, not preceded by a letter,
 * a colon, a backslash or a slash, so a comment or an escaped regular expression is not taken for one).
 */
const ADDRESS = /(?:(?:https?|wss?):\/\/|(?<![\w:\\/])\/\/(?=[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}))[^\s"'`)\\<>]+/g;

/** Every address in the text that is not allowed. */
export function strangers(text: string): string[] {
  return (text.match(ADDRESS) ?? []).filter((address) => {
    const host = /^(?:[a-z]+:)?\/\/([^/:]+)/.exec(address)?.[1] ?? '';
    return !HOSTS.has(host) && !NOT_REQUESTS.some((allowed) => address.startsWith(allowed));
  });
}

/** Addresses that are text inside the libraries, never requested. */
const NOT_REQUESTS = [
  'http://www.w3.org/', // React: the SVG, MathML, XLink and XML namespaces
  'https://react.dev/errors/', // React: the link in its minified error messages
  'http://json-schema.org/', // zod: the JSON Schema dialects it can write
  'https://json-schema.org/',
  'http://[${e}]', // zod: how it checks an IPv6 address, by building a URL around it
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(js|html|json|css)$/.test(name) ? [path] : [];
  });
}

describe('the built extension', () => {
  it('names no address but 127.0.0.1, github.com and the libraries\' namespace strings', (ctx) => {
    if (BUILDS.length === 0) ctx.skip(NO_BUILD);
    const others: string[] = [];
    for (const dir of BUILDS) {
      for (const file of files(dir)) {
        for (const address of strangers(readFileSync(file, 'utf8'))) others.push(`${file.slice(dir.length + 1)}: ${address}`);
      }
    }
    expect(others).toEqual([]);
  });

  it('refuses ws, wss and protocol-relative addresses, and lets the allowed ones through (second round)', () => {
    expect(strangers('new WebSocket("ws://evil.example/x"); new WebSocket(`wss://evil.example:8443/`)')).toEqual([
      'ws://evil.example/x', 'wss://evil.example:8443/',
    ]);
    expect(strangers('img.src="//cdn.evil.example/p.gif"; fetch(\'//evil.example\')')).toEqual(['//cdn.evil.example/p.gif', '//evil.example']);
    expect(strangers('fetch("http://127.0.0.1:4611/hello"); open("https://github.com/a/b"); x="//github.com/a"; y="ws://127.0.0.1:4611"')).toEqual([]);
    // A comment and an escaped regular expression are not addresses.
    expect(strangers('a = 1; // see the docs.example page\n/^\\/\\/x/.test(s); s.split("//")')).toEqual([]);
    expect(strangers('xmlns="http://www.w3.org/2000/svg"')).toEqual([]);
  });
});
