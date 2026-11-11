import { z } from 'zod';

// Zod compiles object schemas with `new Function` unless told not to. The extension's content security policy refuses
// that; zod falls back by itself, but Chrome records each refusal as an error on the extension's card. Imported first by
// the side panel, before any schema is used.
z.config({ jitless: true });
