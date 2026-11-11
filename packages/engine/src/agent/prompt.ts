import { readFile } from 'node:fs/promises';

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
const cache = new Map<string, string>();

/** Reads packages/engine/prompts/<name>.md, once per process. */
export async function loadTemplate(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
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

/** Wraps text in a material block. A closing tag inside the text is broken with a zero-width space so it cannot end the block. */
export function asMaterial(label: string, text: string): string {
  const safeLabel = label.replaceAll('"', "'");
  const safeText = text.replace(/<(\/material)/gi, '<​$1');
  return `<material label="${safeLabel}">\n${safeText}\n</material>`;
}
