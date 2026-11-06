// A Mastra agent that uses the Olostep tools.
// Run: OLOSTEP_API_KEY=... OPENAI_API_KEY=... npx tsx examples/agent.ts
import { Agent } from '@mastra/core/agent';
import { createOlostepTools } from '../src/index.js';

const agent = new Agent({
  id: 'web-researcher',
  name: 'Web researcher',
  instructions: 'You answer questions using live web data. Search first, then scrape the best sources. Always cite URLs.',
  model: 'openai/gpt-5-mini',
  tools: createOlostepTools(),
});

const result = await agent.generate(
  'Find the Olostep docs page about crawling and summarize how to crawl a website, with the source URL.',
  { maxSteps: 5 },
);

console.log('Tools called:', result.steps.flatMap(step => step.toolCalls.map(call => call.payload?.toolName ?? call)));
console.log(result.text);
