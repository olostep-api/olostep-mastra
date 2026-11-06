import { createTool } from '@mastra/core/tools';
import { Format, Olostep } from 'olostep';
import { z } from 'zod';

export interface OlostepToolOptions {
  /** Olostep API key. Defaults to the `OLOSTEP_API_KEY` environment variable. */
  apiKey?: string;
  /** Maximum characters of page content returned to the model per page. Default: 20,000. */
  maxCharacters?: number;
  /** How long crawl and batch tools wait for the job to finish, in seconds. Default: 300. */
  timeoutSeconds?: number;
  /** How many pages crawl, batch and results tools return per call, up to 100. Default: 20. */
  pagesPerCall?: number;
  /** Olostep API base URL. Default: https://api.olostep.com/v1. */
  apiBaseUrl?: string;
}

const DEFAULT_MAX_CHARACTERS = 20_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_PAGES_PER_CALL = 20;
const MAX_PAGES_PER_CALL = 100;
const MAX_JOB_SIZE = 100_000;
const DEFAULT_MAP_URLS = 100;
const API_URL = 'https://api.olostep.com/v1';
// Tells Olostep which integration a request came from.
const USER_AGENT = 'olostep-mastra-tools/2.0.0';

type JobKind = 'batches' | 'crawls';

const pageSchema = z.object({
  url: z.string(),
  markdown: z.string(),
  error: z.string().optional(),
});

const jobSchema = z.object({
  id: z.string(),
  status: z.string(),
  pages: z.array(pageSchema).optional(),
  nextCursor: z.string().optional(),
  message: z.string().optional(),
});

type JobResult = z.infer<typeof jobSchema>;
type PageResult = z.infer<typeof pageSchema>;

function waitOptions(options: OlostepToolOptions) {
  return { checkEveryNSecs: 5, timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS };
}

function client(options: OlostepToolOptions): Olostep {
  return new Olostep({ apiKey: options.apiKey, apiBaseUrl: options.apiBaseUrl, userAgent: USER_AGENT });
}

// The SDK reports some HTTP errors misleadingly (a 401 reads "domain is blacklisted") and wraps them
// as connection errors, so this rebuilds the message from the API's own status and response.
function apiError(error: unknown): Error {
  // The SDK keeps the original error in details.cause after its retries.
  const wrapped = error as { cause?: unknown; details?: { cause?: unknown } };
  const cause = wrapped?.details?.cause ?? wrapped?.cause ?? error;
  const response = (cause as { details?: { response?: { status?: number; body?: unknown } } })?.details?.response;
  if (!response?.status) return error instanceof Error ? error : new Error(String(error));
  const body = response.body as Record<string, unknown> | string | undefined;
  const detail = typeof body === 'object' && body ? body.message ?? body.detail ?? body.title : body;
  return new Error(`Olostep API error (HTTP ${response.status})${detail ? `: ${String(detail).slice(0, 300)}` : ''}`);
}

async function guard<O>(run: () => Promise<O>): Promise<O> {
  try {
    return await run();
  } catch (error) {
    throw apiError(error);
  }
}

function truncate(text: string | undefined | null, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n\n[truncated]` : text;
}

function stillRunning(id: string): JobResult {
  return {
    id,
    status: 'in_progress',
    message: 'Still running. Use the olostep-results tool with this id in a few minutes.',
  };
}

// Returns one page of a finished job. The SDK iterators hide the cursor, so this calls the API directly.
async function readPages(options: OlostepToolOptions, kind: JobKind, id: string, cursor?: string): Promise<JobResult> {
  const olostep = client(options);
  const info = (await olostep[kind].info(id)) as { status?: string };
  if (info.status === 'in_progress') return stillRunning(id);

  const limit = Math.max(1, Math.min(options.pagesPerCall ?? DEFAULT_PAGES_PER_CALL, MAX_PAGES_PER_CALL));
  const params = new URLSearchParams({ limit: String(limit) });
  if (kind === 'batches') params.set('status', 'completed');
  if (cursor) params.set('cursor', cursor);
  const path = kind === 'batches' ? 'items' : 'pages';
  const response = await fetch(`${options.apiBaseUrl ?? API_URL}/${kind}/${id}/${path}?${params}`, {
    headers: { Authorization: `Bearer ${options.apiKey ?? process.env.OLOSTEP_API_KEY}`, 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`Olostep API error (HTTP ${response.status}) while listing ${id}`);
  const data = (await response.json()) as {
    items?: { url?: string; retrieve_id?: string }[];
    pages?: { url?: string; retrieve_id?: string }[];
    cursor?: string | number | null;
  };

  const max = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const found = data.items ?? data.pages ?? [];
  const pages = await Promise.all(
    found.map(async ({ url = '', retrieve_id: retrieveId }): Promise<PageResult> => {
      if (!retrieveId) return { url, markdown: '', error: 'No content is available for this page.' };
      try {
        const content = await olostep.retrieve.get({ retrieveId, formats: [Format.MARKDOWN] });
        return { url, markdown: truncate(content.markdown_content, max) };
      } catch (error) {
        return { url, markdown: '', error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  const result: JobResult = { id, status: info.status ?? 'completed', pages };
  // The API returns a cursor until the listing is exhausted, which can end on an empty page.
  if (found.length > 0 && data.cursor !== undefined && data.cursor !== null) {
    result.nextCursor = String(data.cursor);
    result.message = 'More pages are available. Use the olostep-results tool with this id and nextCursor.';
  } else if (found.length === 0 && !cursor) {
    // The API reports a job whose URLs all failed as completed with nothing in it.
    result.message = `The ${kind === 'crawls' ? 'crawl' : 'batch'} finished but returned no pages. The URLs may be unreachable, blocked or returning errors.`;
  }
  return result;
}

// waitTillDone throws when the time runs out, which is normal for a large job.
async function waitThenRead(
  options: OlostepToolOptions,
  kind: JobKind,
  job: { id: string; waitTillDone: (wait: ReturnType<typeof waitOptions>) => Promise<void> },
): Promise<JobResult> {
  try {
    await job.waitTillDone(waitOptions(options));
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) return stillRunning(job.id);
    throw error;
  }
  return readPages(options, kind, job.id);
}

// The API returns the answer as a JSON string, usually {"result": "..."}.
function parseAnswer(answer: string | null): unknown {
  if (!answer) return null;
  try {
    const parsed = JSON.parse(answer);
    return parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed;
  } catch {
    return answer;
  }
}

/** Scrape a single URL and return its content as clean markdown. */
export function createOlostepScrapeTool(options: OlostepToolOptions = {}) {
  return createTool({
    id: 'olostep-scrape',
    description:
      'Scrape a web page and return its content as clean markdown. Handles JavaScript-rendered pages. Use when you need the full content of a specific URL.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL of the page to scrape'),
      waitBeforeScraping: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe('Milliseconds to wait for JavaScript-heavy pages to render'),
    }),
    outputSchema: z.object({ url: z.string(), markdown: z.string() }),
    execute: ({ url, waitBeforeScraping }) =>
      guard(async () => {
        const result = await client(options).scrapes.create({ url, formats: ['markdown'], waitBeforeScraping });
        return { url, markdown: truncate(result.markdown_content, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS) };
      }),
  });
}

/** Search the web and return a list of results with titles, URLs and descriptions. */
export function createOlostepSearchTool(options: OlostepToolOptions = {}) {
  return createTool({
    id: 'olostep-search',
    description:
      'Search the live web. Returns result titles, URLs and descriptions. Use to find current information or sources to scrape.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
      limit: z.number().int().min(1).max(25).optional().describe('Maximum number of results, up to 25 (default 10)'),
    }),
    outputSchema: z.object({
      query: z.string(),
      results: z.array(
        z.object({ title: z.string().nullish(), url: z.string(), description: z.string().nullish() }),
      ),
    }),
    execute: ({ query, limit }) =>
      guard(async () => {
        const result = await client(options).searches.create({ query, limit });
        return {
          query,
          results: result.links.map(link => ({ title: link.title, url: link.url, description: link.description })),
        };
      }),
  });
}

/** Answer a question using live web data, with source URLs. */
export function createOlostepAnswerTool(options: OlostepToolOptions = {}) {
  return createTool({
    id: 'olostep-answer',
    description:
      'Answer a question by searching and reading the live web. Returns an answer with source URLs. Use for factual or current-events questions that need citations.',
    inputSchema: z.object({
      task: z.string().describe('The question or research task'),
    }),
    outputSchema: z.object({ answer: z.unknown(), sources: z.array(z.string()).nullish() }),
    execute: ({ task }) =>
      guard(async () => {
        const result = await client(options).answers.create({ task });
        return { answer: parseAnswer(result.answer), sources: result.sources };
      }),
  });
}

/** List the URLs on a website, optionally ranked by relevance to a query. */
export function createOlostepMapTool(options: OlostepToolOptions = {}) {
  return createTool({
    id: 'olostep-map',
    description:
      'Discover the URLs on a website. Optionally rank them by relevance to a search query. Use to find the right pages on a site before scraping them.',
    inputSchema: z.object({
      url: z.string().url().describe('The website to map'),
      searchQuery: z.string().optional().describe('Rank URLs by relevance to this query'),
      topN: z
        .number()
        .int()
        .min(1)
        .max(MAX_JOB_SIZE)
        .optional()
        .describe(`Maximum number of URLs to return, up to 100k (default ${DEFAULT_MAP_URLS})`),
    }),
    outputSchema: z.object({ url: z.string(), urls: z.array(z.string()) }),
    execute: ({ url, searchQuery, topN }) =>
      guard(async () => {
        // Large sites have thousands of URLs, so the default keeps the result small enough for the model.
        const result = await client(options).maps.create({ url, searchQuery, topN: topN ?? DEFAULT_MAP_URLS });
        const urls: string[] = [];
        for await (const found of result.urls()) urls.push(found);
        return { url, urls };
      }),
  });
}

/** Crawl a website and return the markdown content of each page. */
export function createOlostepCrawlTool(options: OlostepToolOptions = {}) {
  return createTool({
    id: 'olostep-crawl',
    description:
      'Crawl a website from a starting URL and return the markdown content of each page found. Use to read several pages of a site, such as documentation. Large crawls return an id or nextCursor: use the olostep-results tool to get the remaining pages.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL to start crawling from'),
      maxPages: z.number().int().min(1).max(MAX_JOB_SIZE).optional().describe('Maximum pages to crawl, up to 100k (default 5)'),
      includeUrls: z
        .array(z.string())
        .optional()
        .describe('Only crawl URLs matching these glob patterns, e.g. ["/docs/**"]'),
    }),
    outputSchema: jobSchema,
    execute: ({ url, maxPages, includeUrls }) =>
      guard(async () => {
        const crawl = await client(options).crawls.create({ url, maxPages: maxPages ?? 5, includeUrls });
        return waitThenRead(options, 'crawls', crawl);
      }),
  });
}

/** Scrape a list of URLs in a batch and return the markdown of each page. */
export function createOlostepBatchTool(options: OlostepToolOptions = {}) {
  return createTool({
    id: 'olostep-batch',
    description:
      'Scrape up to 100k URLs per batch and return the markdown of each page. Use when you already have a list of URLs to read; for one or two URLs use the olostep-scrape tool instead. Can take a few minutes. Large batches return an id or nextCursor: use the olostep-results tool to get the remaining pages.',
    inputSchema: z.object({
      urls: z.array(z.string().url()).min(1).max(MAX_JOB_SIZE).describe('The URLs to scrape (up to 100k)'),
    }),
    outputSchema: jobSchema,
    execute: ({ urls }) =>
      guard(async () => {
        const batch = await client(options).batches.create(urls);
        return waitThenRead(options, 'batches', batch);
      }),
  });
}

/** Get the pages of a crawl or batch by its id, a set at a time. */
export function createOlostepResultsTool(options: OlostepToolOptions = {}) {
  return createTool({
    id: 'olostep-results',
    description:
      'Get the markdown pages of a crawl or batch by its id (crawl_... or batch_...). Use when the crawl or batch tool returned status in_progress or a nextCursor.',
    inputSchema: z.object({
      id: z.string().describe('The crawl or batch id, starting with crawl_ or batch_'),
      cursor: z.string().optional().describe('The nextCursor from a previous result. Leave empty for the first pages.'),
    }),
    outputSchema: jobSchema,
    execute: async ({ id, cursor }) => {
      const kind: JobKind | null = id.startsWith('batch_') ? 'batches' : id.startsWith('crawl_') ? 'crawls' : null;
      if (!kind) throw new Error(`Enter a crawl or batch id, for example crawl_abc123 or batch_abc123 (got ${id}).`);
      return guard(() => readPages(options, kind, id, cursor));
    },
  });
}

/** All Olostep tools, keyed by name, ready to pass to a Mastra `Agent`. */
export function createOlostepTools(options: OlostepToolOptions = {}) {
  return {
    olostepScrape: createOlostepScrapeTool(options),
    olostepSearch: createOlostepSearchTool(options),
    olostepAnswer: createOlostepAnswerTool(options),
    olostepMap: createOlostepMapTool(options),
    olostepCrawl: createOlostepCrawlTool(options),
    olostepBatch: createOlostepBatchTool(options),
    olostepResults: createOlostepResultsTool(options),
  };
}
