// Calls each Olostep tool directly, the way a Mastra agent would, without an LLM.
// Run: OLOSTEP_API_KEY=... npx tsx examples/tools.ts
import { createOlostepTools } from '../src/index.js';

const tools = createOlostepTools({ maxCharacters: 300, timeoutSeconds: 120 });

async function show(name: string, input: unknown) {
  const started = Date.now();
  const execute = tools[name as keyof typeof tools].execute as (input: unknown, context: unknown) => Promise<unknown>;
  const result = await execute(input, {});
  console.log(`\n### ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  console.log(JSON.stringify(result, null, 2).slice(0, 800));
}

await show('olostepScrape', { url: 'https://example.com' });
await show('olostepSearch', { query: 'Mastra AI agent framework', limit: 3 });
await show('olostepAnswer', { task: 'What is the capital of Japan?' });
await show('olostepMap', { url: 'https://docs.olostep.com', topN: 5 });
await show('olostepCrawl', { url: 'https://docs.olostep.com', maxPages: 2 });
await show('olostepBatch', { urls: ['https://example.com', 'https://example.org'] });
