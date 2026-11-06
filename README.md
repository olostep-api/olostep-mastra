# @olostep/mastra-tools

**Live web search, scraping and crawling API for AI. Get structured, LLM-ready data from any site. Scale to 1M requests with 10 parallel batches at low cost.**

[Olostep](https://www.olostep.com) is web data infrastructure for AI agents and enterprise AI workflows. Its APIs provide live web search, scraping and crawling to extract, clean and structure data from the web. This package gives [Mastra](https://mastra.ai) agents ready-made Olostep tools, built with Mastra's `createTool()`.

## Why Olostep

- Web data infrastructure for developers and enterprises
- Scales to hundreds of millions to billions of requests per customer per month
- The most performant, reliable and cost-effective API on the market
- Used by the fastest-growing AI companies

From extracting data from a handful of URLs to crawling hundreds of millions of pages, Olostep gives developers and AI companies reliable, scalable and highly cost-effective access to clean, structured web data.

## Install

```bash
npm install @olostep/mastra-tools @mastra/core zod
```

Get an API key at [olostep.com/auth](https://olostep.com/auth) and set it as `OLOSTEP_API_KEY`.

## Usage

```ts
import { Agent } from '@mastra/core/agent';
import { createOlostepTools } from '@olostep/mastra-tools';

const agent = new Agent({
  id: 'web-researcher',
  name: 'Web researcher',
  instructions: 'You answer questions using live web data. Search first, then scrape the best sources. Always cite URLs.',
  model: 'openai/gpt-5-mini',
  tools: createOlostepTools(),
});

const result = await agent.generate('Read the Next.js 15 release notes and list the breaking changes, with sources.');
console.log(result.text);
```

Or pick individual tools:

```ts
import { createOlostepScrapeTool, createOlostepSearchTool } from '@olostep/mastra-tools';

const tools = {
  olostepScrape: createOlostepScrapeTool(),
  olostepSearch: createOlostepSearchTool(),
};
```

The tools also work in Mastra workflows and anywhere Mastra accepts a tool.

## Tools

| Factory | Tool id | What it does |
|---|---|---|
| `createOlostepScrapeTool` | `olostep-scrape` | Scrape a URL and return clean markdown (JavaScript rendering included) |
| `createOlostepSearchTool` | `olostep-search` | Search the live web and return titles, URLs and descriptions (1 to 25 results) |
| `createOlostepAnswerTool` | `olostep-answer` | Answer a question from the live web, with source URLs |
| `createOlostepMapTool` | `olostep-map` | List the URLs on a website, optionally ranked by a query |
| `createOlostepCrawlTool` | `olostep-crawl` | Crawl a site and return the markdown of each page, 20 at a time by default |
| `createOlostepBatchTool` | `olostep-batch` | Scrape up to 100k URLs per batch and return the markdown of each page, 20 at a time by default |
| `createOlostepResultsTool` | `olostep-results` | Get the remaining pages of a crawl or batch |
| `createOlostepTools` | | All of the above, keyed by name |

## Options

Every factory accepts the same options:

```ts
createOlostepTools({
  apiKey: 'olostep_...',   // defaults to process.env.OLOSTEP_API_KEY
  maxCharacters: 20_000,   // max page content returned to the model, per page
  timeoutSeconds: 300,     // how long crawl and batch tools wait for the job to finish
  pagesPerCall: 20,        // pages returned per call, up to 100
});
```

## Large crawls and batches

Page content goes to the model, so large jobs return their pages a set at a time. If a job is still running when the wait ends, the tool returns its `id` with `status` set to `in_progress`. If more pages are available, the result includes `nextCursor`. The agent passes the `id` and `nextCursor` to `olostep-results` to get the next pages, until it has every page.

Batches go up to 100k URLs, and you can run 10 batches in parallel for 1M requests. New accounts start at 100 URLs per batch, and info@olostep.com can lift this.

## Upgrading from 1.x

Version 1.x was built for Mastra 0.1 and its `integrations` / `mastra.callApi` API, which current Mastra no longer has. Version 2 uses `createTool()` and works with `@mastra/core` 1.x. Replace `createOlostepIntegration()` and `callApi` with `createOlostepTools()` passed to your agent's `tools`.

## Examples

```bash
# Call each tool directly (no LLM needed)
OLOSTEP_API_KEY=... npx tsx examples/tools.ts

# Run a Mastra agent
OLOSTEP_API_KEY=... OPENAI_API_KEY=... npx tsx examples/agent.ts
```

## About Olostep

[Olostep](https://www.olostep.com) is web data infrastructure for AI agents and enterprise AI workflows. It helps businesses power AI agents, knowledge bases and data-intensive workflows without the high costs of traditional web data infrastructure, and it is trusted by some of the fastest-growing businesses in the world.

- Website: https://www.olostep.com
- Documentation: https://docs.olostep.com
- Get an API key: https://olostep.com/auth

## License

MIT
