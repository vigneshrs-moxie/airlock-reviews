import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { MESSAGE_MAX } from '@airlock/shared';
import type { ZodType } from 'zod';
import { isExtensionOrigin } from './config.js';

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: unknown;
  origin: string | null;
}

/**
 * A stream handler gets `send` (one `data:` line per value), `closed` (aborted when the client goes away) and
 * `comment` (one `: <text>` line, for keep-alives; line breaks in the text become spaces).
 */
export type StreamWriter = (send: (e: unknown) => void, closed: AbortSignal, comment: (text: string) => void) => Promise<void>;

export type Res =
  | { status: number; json: unknown }
  | { status: 200; stream: StreamWriter };

export type Handler = (req: Req) => Promise<Res>;

export interface Route {
  method: string;
  path: string;
  /**
   * Open routes need no token and answer whatever the Origin header is (a page cannot read the reply: no Access-Control
   * header is ever sent). They still get the Host check.
   */
  open?: boolean;
  /** The pairing route: the Origin header is required and must be a chrome-extension origin; the handler decides the rest. */
  pairing?: boolean;
  /**
   * The Origin header must be present and equal the paired origin (not merely checked when present): the routes that can
   * lead to a GitHub write, so a local command without the extension's Origin cannot reach them.
   */
  requiresOrigin?: boolean;
  /** The most bytes this route's body may have, in place of MAX_BODY_BYTES; checked while the body is read. */
  maxBodyBytes?: number;
  body?: ZodType;
  query?: ZodType;
  handler: Handler;
}

/** `port` is read on every request, so the server can set it once it knows the port it really listens on. */
export interface Auth { token: string; port: number; pairedOrigin: () => Promise<string | null> }

export const MAX_BODY_BYTES = 64 * 1024;
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_LOGGED_PATH = 200;

const NOT_HERE = 'Airlock only answers on this Mac.';
const NOT_THIS_PAGE = 'Airlock does not accept requests from this page.';
const NEEDS_TOKEN = 'Airlock needs its pairing token.';

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  if (match === null) return false;
  return timingSafeEqual(sha256(match[1] as string), sha256(token));
}

function firstProblem(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'The request is not valid.';
  const where = issue.path.map(String).join('.');
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}

/** The decoded segments of a raw path, or null when it cannot be decoded or holds `..` or a NUL. */
function decodeSegments(rawPath: string): string[] | null {
  if (!rawPath.startsWith('/')) return null;
  try {
    const segments = rawPath.slice(1).split('/').map((s) => decodeURIComponent(s));
    if (segments.some((s) => s.includes('..') || s.includes('\0'))) return null;
    return segments;
  } catch {
    return null;
  }
}

function matchRoute(route: Route, segments: string[]): Record<string, string> | null {
  const pattern = route.path.slice(1).split('/');
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of pattern.entries()) {
    const segment = segments[i] as string;
    if (part.startsWith(':')) {
      if (segment === '' || segment.includes('/')) return null;
      params[part.slice(1)] = segment;
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
}

type BodyResult = { ok: true; text: string } | { ok: false; status: 413 };

/** Reads at most `limit` bytes. Past that it stops reading and reports 413; the caller answers and closes the connection. */
function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (result: BodyResult): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        done({ ok: false, status: 413 });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => done({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    const onError = (e: Error): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      reject(e);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });
}

function writeJson(res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(json), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(payload);
}

async function writeStream(
  res: ServerResponse, stream: StreamWriter, failure: (e: unknown) => string, log: (e: unknown) => void,
): Promise<void> {
  const gone = new AbortController();
  res.on('close', () => gone.abort());
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.flushHeaders();
  const send = (e: unknown): void => {
    if (gone.signal.aborted || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const comment = (text: string): void => {
    if (gone.signal.aborted || res.writableEnded) return;
    res.write(`: ${text.replace(/[\r\n]+/g, ' ')}\n\n`);
  };
  try {
    await stream(send, gone.signal, comment);
  } catch (e) {
    log(e);
    send({ type: 'failed', message: failure(e) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/** The text with every absolute path under the given folders replaced by `<path>`. */
export function hidePathsIn(text: string, hidePaths: readonly string[]): string {
  let hidden = text;
  for (const folder of hidePaths) {
    if (folder === '') continue;
    hidden = hidden.replace(new RegExp(`${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s'"\`]*`, 'g'), '<path>');
  }
  return hidden;
}

/**
 * An error sentence made safe to send: `lead` then the error's message, in which absolute paths under the given folders
 * become `<path>` and line breaks become one space. The whole sentence is cut once to MESSAGE_MAX characters (code
 * points), ending in `…`, which is what the panel shows. The log keeps the whole message.
 */
export function plainMessage(e: unknown, hidePaths: readonly string[], lead = ''): string {
  const message = hidePathsIn(e instanceof Error ? e.message : String(e), hidePaths);
  const chars = [...`${lead}${message.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ')}`];
  return chars.length <= MESSAGE_MAX ? chars.join('') : `${chars.slice(0, MESSAGE_MAX - 1).join('')}…`;
}

export interface RouterOptions {
  /** Folders (the home folder, the Airlock home) whose paths are replaced by `<path>` in error replies. */
  hidePaths?: readonly string[];
}

export function createRouter(
  routes: Route[], auth: Auth, log: (line: string) => void = () => undefined, options: RouterOptions = {},
): RequestListener {
  const hidePaths = options.hidePaths ?? [];
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const queryStart = url.indexOf('?');
    const rawPath = queryStart === -1 ? url : url.slice(0, queryStart);
    const rawQuery = queryStart === -1 ? '' : url.slice(queryStart + 1);

    // The log line is written once the response is over: method, path without its query, status, time. A /hello that
    // was answered is not logged: every open panel asks it every few seconds.
    const started = Date.now();
    res.on('close', () => {
      if (method === 'GET' && rawPath === '/hello' && res.statusCode === 200) return;
      log(`${method} ${rawPath.slice(0, MAX_LOGGED_PATH)} ${res.statusCode} ${Date.now() - started}ms`);
    });

    // Check 1: the Host header names this Mac and the port we really listen on.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${auth.port}` && host !== `localhost:${auth.port}`) {
      writeJson(res, 403, { error: NOT_HERE });
      return;
    }
    if (method === 'OPTIONS') {
      writeJson(res, 403, { error: NOT_THIS_PAGE });
      return;
    }

    const segments = decodeSegments(rawPath);
    const candidates = segments === null
      ? []
      : routes.flatMap((route) => {
        const params = matchRoute(route, segments);
        return params === null ? [] : [{ route, params }];
      });
    if (candidates.length === 0) {
      writeJson(res, 404, { error: 'Airlock has nothing at this address.' });
      return;
    }
    const found = candidates.find((c) => c.route.method === method);
    if (found === undefined) {
      writeJson(res, 405, { error: 'This address does not accept that method.' }, { Allow: candidates.map((c) => c.route.method).join(', ') });
      return;
    }
    const { route, params } = found;

    // Check 2: an Origin header, when present, is the paired extension (or, for pairing, any extension); a route that
    // requires one refuses a request without it. The open route answers any Origin, so pairing can begin whatever a
    // browser sends with it.
    const origin = req.headers.origin ?? null;
    if (route.requiresOrigin === true && origin === null) {
      writeJson(res, 403, { error: NOT_THIS_PAGE });
      return;
    }
    if (route.pairing === true) {
      if (origin === null || !isExtensionOrigin(origin)) {
        writeJson(res, 403, { error: NOT_THIS_PAGE });
        return;
      }
    } else if (route.open !== true && origin !== null && origin !== (await auth.pairedOrigin())) {
      writeJson(res, 403, { error: NOT_THIS_PAGE });
      return;
    }

    // Check 3: the pairing token, compared in constant time.
    if (route.open !== true && !tokenMatches(req.headers.authorization, auth.token)) {
      writeJson(res, 401, { error: NEEDS_TOKEN });
      return;
    }

    const rawParams = new URLSearchParams(rawQuery);
    const keys = [...rawParams.keys()];
    if (new Set(keys).size !== keys.length) {
      writeJson(res, 400, { error: 'A query value was given twice.' });
      return;
    }
    let query = rawParams;
    if (route.query !== undefined) {
      const parsed = route.query.safeParse(Object.fromEntries(rawParams));
      if (!parsed.success) {
        writeJson(res, 400, { error: firstProblem(parsed.error) });
        return;
      }
      // The handler sees what the schema accepted, not the raw text.
      query = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed.data as Record<string, unknown>)) {
        if (value !== undefined && value !== null) query.set(key, String(value));
      }
    }

    let body: unknown;
    if (METHODS_WITH_BODY.has(method)) {
      const length = req.headers['content-length'];
      const announced = req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
      if (announced) {
        const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
        if (type !== 'application/json') {
          writeJson(res, 415, { error: 'Airlock only accepts application/json.' }, { Connection: 'close' });
          return;
        }
        const limit = route.maxBodyBytes ?? MAX_BODY_BYTES;
        if (length !== undefined && Number(length) > limit) {
          writeJson(res, 413, { error: 'The request body is too large.' }, { Connection: 'close' });
          return;
        }
        const read = await readBody(req, limit);
        if (!read.ok) {
          res.once('finish', () => req.destroy());
          writeJson(res, 413, { error: 'The request body is too large.' }, { Connection: 'close' });
          return;
        }
        if (read.text !== '') {
          try {
            body = JSON.parse(read.text);
          } catch {
            writeJson(res, 400, { error: 'The request body is not valid JSON.' });
            return;
          }
        }
      }
      if (route.body !== undefined) {
        const parsed = route.body.safeParse(body);
        if (!parsed.success) {
          writeJson(res, 400, { error: firstProblem(parsed.error) });
          return;
        }
        body = parsed.data;
      }
    }

    let reply: Res;
    try {
      reply = await route.handler({ method, path: rawPath, query, params, body, origin });
    } catch (e) {
      log(`${method} ${rawPath.slice(0, MAX_LOGGED_PATH)} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      writeJson(res, 500, { error: plainMessage(e, hidePaths, 'Airlock had a problem: ') });
      return;
    }
    if ('stream' in reply) {
      await writeStream(
        res, reply.stream, (e) => plainMessage(e, hidePaths, 'Airlock had a problem: '),
        (e) => log(`${method} ${rawPath.slice(0, MAX_LOGGED_PATH)} stream failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`),
      );
      return;
    }
    writeJson(res, reply.status, reply.json);
  };

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`${req.method ?? '?'} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) writeJson(res, 500, { error: 'Airlock had a problem: the request could not be handled.' });
      else res.end();
    });
  };
}
