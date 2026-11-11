import { readFile } from 'node:fs/promises';

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
const cache = new Map<string, string>();

/** Reads packages/engine/prompts/<name>.md, once per process. */
export async function loadTemplate(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid prompt template name "${name}"`);
  let text: string;
  try {
    text = await readFile(new URL(`${name}.md`, PROMPTS_DIR), 'utf8');
  } catch (err) {
    throw new Error(`Prompt template "${name}" could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  cache.set(name, text);
  return text;
}

/** Replaces {{name}} with vars[name]. A variable the template names but vars lacks throws. Values are inserted literally. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`Template variable "${key}" has no value`);
    return vars[key]!;
  });
}

/**
 * The line that splits a system prompt into a first part that is the same for every request of a review (cached) and the
 * request's own part. It is the Agent SDK's SYSTEM_PROMPT_DYNAMIC_BOUNDARY, written out so loading a prompt does not load
 * the SDK; a test checks the two agree.
 */
export const PROMPT_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/**
 * Instructions cut at the boundary line: `standing` is what comes before it (empty when there is no boundary), `stage`
 * what comes after it (all of it when there is none).
 */
export function splitInstructions(instructions: string): { standing: string; stage: string } {
  const lines = instructions.split('\n');
  const at = lines.indexOf(PROMPT_BOUNDARY);
  if (at === -1) return { standing: '', stage: instructions };
  return { standing: lines.slice(0, at).join('\n').trim(), stage: lines.slice(at + 1).join('\n').trim() };
}

/** Puts a zero-width space after the `<` of any material tag (opening or closing, any case) so it cannot open or close a block. */
const breakTags = (text: string): string => text.replace(/<(\/?material)/gi, '<\u200B$1');

/** Wraps text in a material block. Material tags inside the text are broken so they cannot open or close a block; the label is flattened to one safe line. */
export function asMaterial(label: string, text: string): string {
  const safeLabel = breakTags(label)
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
    .replaceAll('"', "'")
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<material label="${safeLabel}">\n${breakTags(text)}\n</material>`;
}
