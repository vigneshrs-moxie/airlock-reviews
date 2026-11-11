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
  it.skipIf(BUILDS.length === 0)('names no address but 127.0.0.1, github.com and the libraries\' namespace strings', () => {
    const others: string[] = [];
    for (const dir of BUILDS) {
      for (const file of files(dir)) {
        for (const address of readFileSync(file, 'utf8').match(/https?:\/\/[^\s"'`)\\<>]+/g) ?? []) {
          const host = /^https?:\/\/([^/:]+)/.exec(address)?.[1] ?? '';
          if (HOSTS.has(host) || NOT_REQUESTS.some((text) => address.startsWith(text))) continue;
          others.push(`${file.slice(dir.length + 1)}: ${address}`);
        }
      }
    }
    expect(others).toEqual([]);
  });
});
