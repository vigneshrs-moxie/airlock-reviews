import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SeveritySchema, StageSchema } from '@airlock/shared';
import { parse } from 'yaml';
import { z } from 'zod';
import type { StageRule } from '../intake/pr.js';
import { learnedFileName, readLearned } from './learned.js';
import type { CheckDef, LearnedEntry, LensDef, LinkRule, Pack, Rule } from './types.js';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, file: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${file}: missing or invalid "${key}"`);
  return v;
}

function strList(o: Obj, key: string, file: string, required = false): string[] {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${file}: missing "${key}"`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${file}: "${key}" must be a list of text`);
  return v as string[];
}

function objList(o: Obj, key: string, file: string, required = false): Obj[] {
  const v = o[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${file}: missing "${key}"`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => !isObj(x))) throw new Error(`${file}: "${key}" must be a list of entries`);
  return v as Obj[];
}

const text = z.string().min(1);
const list = z.array(z.string());
const CheckSchema = z.object({
  id: text, kind: z.enum(['added-line-matches', 'file-pair', 'new-file-requires', 'file-touched']),
  paths: list, pattern: z.string().optional(), exceptPaths: list.optional(),
  requires: z.array(z.object({ path: text, pattern: z.string().optional() })).optional(), message: text,
});
const LinkRuleSchema = z.object({
  id: text, from: text, capture: text, transform: z.enum(['none', 'camel', 'pascal']).default('none'),
  searchIn: list, detail: text,
});
const SiblingSchema = z.object({ id: text, glob: text });
const StageRuleSchema = z.object({ base: text.optional(), default: z.literal(true).optional(), stage: StageSchema })
  .refine((r) => r.base !== undefined || r.default === true, { message: 'needs "base" or "default: true"' });
const TiersSchema = z.object({ read: list.default([]), trust: list.default([]), ignore: list.default([]) });

function section<T extends z.ZodType>(doc: Obj, key: string, schema: T, file: string, fallback: unknown): z.output<T> {
  const parsed = schema.safeParse(doc[key] ?? fallback);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${file}: invalid "${key}" at ${[key, ...issue.path].join('.')}: ${issue.message}`);
  }
  return parsed.data;
}

function onlyWhenAlone(l: Obj, file: string): boolean {
  if (!Object.hasOwn(l, 'onlyWhenAlone')) return false;
  if (typeof l.onlyWhenAlone !== 'boolean') throw new Error(`${file}: "onlyWhenAlone" must be true or false (lens "${String(l.id)}")`);
  return l.onlyWhenAlone;
}

function dated(s: Obj, file: string): boolean {
  if (typeof s.dated !== 'boolean') throw new Error(`${file}: "dated" must be true or false (standard "${String(s.name)}")`);
  return s.dated;
}

async function readText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path}: file not found`);
    throw err;
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function parseYaml(text: string, file: string): unknown {
  try { return parse(text); } catch (err) {
    throw new Error(`${file}: invalid YAML (${(err as Error).message})`);
  }
}

function splitFrontMatter(text: string, file: string): { meta: Obj; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) throw new Error(`${file}: missing front matter between --- lines`);
  const meta = parseYaml(m[1]!, file);
  if (!isObj(meta)) throw new Error(`${file}: front matter must be a mapping`);
  return { meta, body: m[2] ?? '' };
}

async function loadRule(dir: string, name: string, packId: string): Promise<Rule> {
  const file = `rules/${name}`;
  const label = join(dir, file);
  const { meta, body } = splitFrontMatter(await readText(label), label);
  const paths = strList(meta, 'paths', label, true);
  if (paths.length === 0) throw new Error(`${label}: "paths" must not be empty`);
  const floor = SeveritySchema.safeParse(meta.severityFloor ?? 'note');
  if (!floor.success) throw new Error(`${label}: invalid "severityFloor"`);
  const sourcePrs = meta.sourcePrs ?? [];
  if (!Array.isArray(sourcePrs) || sourcePrs.some((n) => typeof n !== 'number')) {
    throw new Error(`${label}: "sourcePrs" must be a list of numbers`);
  }
  const origin = meta.origin ?? '';
  if (typeof origin !== 'string') throw new Error(`${label}: "origin" must be text`);
  return {
    id: str(meta, 'id', label), title: str(meta, 'title', label), paths, severityFloor: floor.data,
    sourcePrs: sourcePrs as number[], origin, body, packId,
  };
}

export async function loadPack(dir: string): Promise<Pack> {
  const root = resolve(dir);
  const yamlPath = join(root, 'pack.yaml');
  const doc = parseYaml(await readText(yamlPath), yamlPath);
  if (!isObj(doc)) throw new Error(`${yamlPath}: must be a mapping`);

  const id = str(doc, 'id', yamlPath);
  const lensEntries = objList(doc, 'lenses', yamlPath, true);
  const lenses: LensDef[] = [];
  for (const l of lensEntries) {
    lenses.push({
      id: str(l, 'id', yamlPath), title: str(l, 'title', yamlPath),
      instructions: await readText(join(root, str(l, 'file', yamlPath))),
      onlyWhenAlone: onlyWhenAlone(l, yamlPath),
    });
  }
  const standards: Pack['standards'] = [];
  for (const s of objList(doc, 'standards', yamlPath)) {
    standards.push({
      name: str(s, 'name', yamlPath), dated: dated(s, yamlPath),
      text: await readText(join(root, str(s, 'file', yamlPath))),
    });
  }

  const rules: Rule[] = [];
  const seen = new Map<string, string>();
  for (const name of await listMarkdown(join(root, 'rules'))) {
    const rule = await loadRule(root, name, id);
    const earlier = seen.get(rule.id);
    if (earlier) throw new Error(`Duplicate rule id "${rule.id}" in rules/${earlier} and rules/${name}`);
    seen.set(rule.id, name);
    rules.push(rule);
  }
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const learned: LearnedEntry[] = [];
  const learnedProblems: string[] = [];
  for (const kind of ['wrong', 'intended'] as const) {
    const path = join(root, 'learned', learnedFileName(kind));
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const read = readLearned(text, kind, path);
    learned.push(...read.entries);
    // Relative to the pack, never the line's text: the note that carries it is shown to people and models.
    learnedProblems.push(...read.badLines.map((n) => `${id}/learned/${learnedFileName(kind)}:${n}`));
  }

  const appRoot = doc.appRoot ?? null;
  if (appRoot !== null && typeof appRoot !== 'string') throw new Error(`${yamlPath}: "appRoot" must be text`);
  const version = doc.version;

  return {
    id, title: str(doc, 'title', yamlPath),
    version: version === undefined || version === null ? 'local' : String(version),
    dir: root, repos: strList(doc, 'repos', yamlPath), appRoot,
    stageRules: section(doc, 'stageRules', z.array(StageRuleSchema), yamlPath, []) as StageRule[],
    tiers: section(doc, 'tiers', TiersSchema, yamlPath, {}),
    siblings: section(doc, 'siblings', z.array(SiblingSchema), yamlPath, []),
    linkRules: section(doc, 'linkRules', z.array(LinkRuleSchema), yamlPath, []) as LinkRule[],
    checks: section(doc, 'checks', z.array(CheckSchema), yamlPath, []) as CheckDef[],
    standards, lenses, rules, learned, learnedProblems,
  };
}
