import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import {
  createOlostepAnswerTool,
  createOlostepBatchTool,
  createOlostepCrawlTool,
  createOlostepMapTool,
  createOlostepResultsTool,
  createOlostepScrapeTool,
  createOlostepSearchTool,
  createOlostepTools,
} from '../src/index.js';

const KEY = 'test-key';

type Handler = (
  url: URL,
  init: { method?: string; headers: Record<string, string | string[] | undefined>; body?: any },
) => unknown;

class ApiError {
  constructor(readonly status: number, readonly body: unknown = {}) {}
}

// The Olostep SDK uses node-fetch, so the tools talk to this local server rather than a mocked global fetch.
let server: Server;
let apiBaseUrl: string;
let handler: Handler;
let calls: URL[];

function mockApi(next: Handler) {
  handler = next;
  calls = [];
  return calls;
}

function opts<T extends object>(extra?: T) {
  return { apiBaseUrl, ...extra };
}

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    calls.push(url);
    let raw = '';
    request.on('data', chunk => (raw += chunk));
    request.on('end', () => {
      let status = 200;
      let body: unknown;
      try {
        body = handler(url, { method: request.method, headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
      } catch (error) {
        status = 500;
        body = { detail: String(error) };
      }
      if (body instanceof ApiError) {
        status = body.status;
        body = body.body;
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  apiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// Runs a tool the way a Mastra agent does: through tool.execute, which validates input and output.
async function run(toolInstance: { execute?: unknown }, input: unknown) {
  const execute = toolInstance.execute as (input: unknown, context: unknown) => Promise<any>;
  const result = await execute(input, {});
  if (result && result.error === true) throw new Error(result.message);
  return result;
}

async function accepts(toolInstance: { inputSchema?: unknown }, input: unknown) {
  const schema = toolInstance.inputSchema as { '~standard': { validate: (value: unknown) => unknown } };
  const result = (await schema['~standard'].validate(input)) as { issues?: unknown[] };
  return !result.issues;
}

function items(count: number, start = 0) {
  return Array.from({ length: count }, (_, i) => ({ url: `https://a.com/${start + i}`, retrieve_id: `r${start + i}` }));
}

function finishedBatch(pages: (url: URL) => unknown): Handler {
  return (url, init) => {
    if (url.pathname.endsWith('/batches') && init.method === 'POST') return { id: 'batch_1', total_urls: 2 };
    if (url.pathname.endsWith('/batches/batch_1')) return { id: 'batch_1', status: 'completed' };
    if (url.pathname.endsWith('/batches/batch_1/items')) return pages(url);
    if (url.pathname.endsWith('/retrieve')) return { markdown_content: `content of ${url.searchParams.get('retrieve_id')}` };
    throw new Error(`Unexpected request ${url}`);
  };
}

beforeEach(() => {
  process.env.OLOSTEP_API_KEY = KEY;
});

test('batch accepts the 100k limit and rejects more', async () => {
  const batch = createOlostepBatchTool();
  const urls = (count: number) => ({ urls: Array.from({ length: count }, () => 'https://a.com') });
  assert.equal(await accepts(batch, urls(100_000)), true);
  assert.equal(await accepts(batch, urls(100_001)), false);
  assert.equal(await accepts(batch, urls(0)), false);
});

test('crawl, map and search accept their documented limits', async () => {
  assert.equal(await accepts(createOlostepCrawlTool(), { url: 'https://a.com', maxPages: 100_000 }), true);
  assert.equal(await accepts(createOlostepCrawlTool(), { url: 'https://a.com', maxPages: 100_001 }), false);
  assert.equal(await accepts(createOlostepMapTool(), { url: 'https://a.com', topN: 100_000 }), true);
  assert.equal(await accepts(createOlostepSearchTool(), { query: 'q', limit: 25 }), true);
  assert.equal(await accepts(createOlostepSearchTool(), { query: 'q', limit: 26 }), false);
});

test('invalid input is returned to the agent as a validation error', async () => {
  await assert.rejects(run(createOlostepBatchTool(opts()), { urls: [] }), /validation failed/);
});

test('batch returns the pages of a finished job', async () => {
  const calls = mockApi(finishedBatch(() => ({ items: items(2), cursor: null })));
  const result = await run(createOlostepBatchTool(opts()), { urls: ['https://a.com/0', 'https://a.com/1'] });

  assert.deepEqual(result, {
    id: 'batch_1',
    status: 'completed',
    pages: [
      { url: 'https://a.com/0', markdown: 'content of r0' },
      { url: 'https://a.com/1', markdown: 'content of r1' },
    ],
  });
  const list = calls.find(url => url.pathname.endsWith('/items'))!;
  assert.equal(list.searchParams.get('limit'), '20');
  assert.equal(list.searchParams.get('status'), 'completed');
});

test('a full page returns nextCursor and the results tool continues from it', async () => {
  const calls = mockApi(
    finishedBatch(url => {
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      if (cursor === 0) return { items: items(2), cursor: 2 };
      return cursor === 2 ? { items: items(1, 2), cursor: 3 } : { items: [] };
    }),
  );
  const results = createOlostepResultsTool(opts({ pagesPerCall: 2 }));
  const first = await run(results, { id: 'batch_1' });
  assert.equal(first.pages.length, 2);
  assert.equal(first.nextCursor, '2');

  const second = await run(results, { id: 'batch_1', cursor: first.nextCursor });
  assert.equal(second.pages[0].url, 'https://a.com/2');
  assert.equal(second.nextCursor, '3');

  const third = await run(results, { id: 'batch_1', cursor: second.nextCursor });
  assert.deepEqual(third.pages, []);
  assert.equal(third.nextCursor, undefined);
  assert.deepEqual(calls.filter(url => url.pathname.endsWith('/items')).map(url => url.searchParams.get('cursor')), [null, '2', '3']);
});

test('pagesPerCall stays between 1 and 100', async () => {
  for (const [pagesPerCall, expected] of [[500, '100'], [0, '1'], [-5, '1']] as const) {
    const calls = mockApi(finishedBatch(() => ({ items: [], cursor: null })));
    await run(createOlostepResultsTool(opts({ pagesPerCall })), { id: 'batch_1' });
    assert.equal(calls.find(url => url.pathname.endsWith('/items'))!.searchParams.get('limit'), expected);
  }
});

test('a job that outlasts the wait returns its id instead of failing', async () => {
  mockApi(url => (url.pathname.endsWith('/batches') ? { id: 'batch_1', total_urls: 1 } : { status: 'in_progress' }));
  const result = await run(createOlostepBatchTool(opts({ timeoutSeconds: 0 })), { urls: ['https://a.com'] });
  assert.equal(result.id, 'batch_1');
  assert.equal(result.status, 'in_progress');
  assert.equal(result.pages, undefined);
});

test('the results tool reports a job that is still running', async () => {
  mockApi(() => ({ status: 'in_progress' }));
  assert.equal((await run(createOlostepResultsTool(opts()), { id: 'crawl_1' })).status, 'in_progress');
});

test('crawl reads pages from the crawl endpoint', async () => {
  const calls = mockApi((url, init) => {
    if (url.pathname.endsWith('/crawls') && init.method === 'POST') return { id: 'crawl_1', status: 'in_progress' };
    if (url.pathname.endsWith('/crawls/crawl_1')) return { id: 'crawl_1', status: 'completed' };
    if (url.pathname.endsWith('/crawls/crawl_1/pages')) return { pages: items(1), cursor: null };
    return { markdown_content: 'page' };
  });
  const result = await run(createOlostepCrawlTool(opts()), { url: 'https://a.com' });
  assert.deepEqual(result.pages, [{ url: 'https://a.com/0', markdown: 'page' }]);
  assert.equal(calls.find(url => url.pathname.endsWith('/pages'))!.searchParams.has('status'), false);
});

test('a page that fails to load is reported without losing the others', async () => {
  mockApi(url => {
    if (url.pathname.endsWith('/batches/batch_1')) return { status: 'completed' };
    if (url.pathname.endsWith('/items')) return { items: items(2), cursor: null };
    if (url.searchParams.get('retrieve_id') === 'r0') return new ApiError(404, { detail: 'gone' });
    return { markdown_content: 'ok' };
  });
  const { pages } = await run(createOlostepResultsTool(opts()), { id: 'batch_1' });
  assert.equal(pages[0].markdown, '');
  assert.ok(pages[0].error);
  assert.equal(pages[1].markdown, 'ok');
});

test('list errors do not expose the API key', async () => {
  mockApi(url => {
    if (url.pathname.endsWith('/items')) return new ApiError(401);
    return { status: 'completed' };
  });
  await assert.rejects(run(createOlostepResultsTool(opts()), { id: 'batch_1' }), error => {
    assert.match(String(error), /HTTP 401/);
    assert.doesNotMatch(String(error), new RegExp(KEY));
    return true;
  });
});

test('the API key option is sent as a bearer token', async () => {
  delete process.env.OLOSTEP_API_KEY;
  let header: string | undefined;
  mockApi((url, init) => {
    if (url.pathname.endsWith('/items')) {
      header = init.headers.authorization as string;
      return { items: [], cursor: null };
    }
    return { status: 'completed' };
  });
  await run(createOlostepResultsTool(opts({ apiKey: 'option-key' })), { id: 'batch_1' });
  assert.equal(header, 'Bearer option-key');
});

test('results rejects an unknown id', async () => {
  await assert.rejects(run(createOlostepResultsTool(opts()), { id: 'job_1' }), /crawl or batch id/);
});

test('scrape truncates content to maxCharacters', async () => {
  mockApi(() => ({ id: 's', result: { markdown_content: 'x'.repeat(50) }, markdown_content: 'x'.repeat(50) }));
  const { markdown } = await run(createOlostepScrapeTool(opts({ maxCharacters: 10 })), { url: 'https://a.com' });
  assert.equal(markdown, `${'x'.repeat(10)}\n\n[truncated]`);
});

test('search returns titles, URLs and descriptions', async () => {
  mockApi(() => ({ id: 'q', result: { links: [{ title: 'A', url: 'https://a.com', description: 'about a' }] } }));
  const result = await run(createOlostepSearchTool(opts()), { query: 'a' });
  assert.deepEqual(result.results, [{ title: 'A', url: 'https://a.com', description: 'about a' }]);
});

test('answer unwraps the JSON result', async () => {
  const answer = JSON.stringify({ result: 'Tokyo' });
  mockApi(() => ({ id: 'a', answer, json_content: answer, result: { json_content: answer, sources: ['https://a.com'] }, sources: ['https://a.com'] }));
  const result = await run(createOlostepAnswerTool(opts()), { task: 'Capital of Japan?' });
  assert.equal(result.answer, 'Tokyo');
});

test('an invalid API key is reported as a 401 with the API message, without the key', async () => {
  mockApi(() => new ApiError(401, { message: 'Your API key is invalid.' }));
  await assert.rejects(run(createOlostepScrapeTool(opts({ apiKey: 'olostep_secret_value' })), { url: 'https://a.com' }), error => {
    assert.match(String(error), /HTTP 401\): Your API key is invalid/);
    assert.doesNotMatch(String(error), /blacklisted|olostep_secret/);
    return true;
  });
});

test('map asks for 100 URLs unless topN is given', async () => {
  const bodies: any[] = [];
  mockApi((url, init) => {
    if (url.pathname.endsWith('/maps')) bodies.push(init.body);
    return { id: 'm', urls: ['https://a.com'] };
  });
  await run(createOlostepMapTool(opts()), { url: 'https://a.com' });
  await run(createOlostepMapTool(opts()), { url: 'https://a.com', topN: 500 });
  assert.deepEqual(bodies.map(body => body.top_n), [100, 500]);
});

test('a finished job with no pages explains why it is empty', async () => {
  mockApi(url => (url.pathname.endsWith('/pages') ? { pages: [], cursor: null } : { status: 'completed' }));
  const result = await run(createOlostepResultsTool(opts()), { id: 'crawl_1' });
  assert.deepEqual(result.pages, []);
  assert.match(result.message, /returned no pages/);
});

test('requests identify the integration in the User-Agent', async () => {
  const agents: string[] = [];
  mockApi((url, init) => {
    agents.push(String(init.headers['user-agent']));
    return url.pathname.endsWith('/items') ? { items: [], cursor: null } : { status: 'completed' };
  });
  await run(createOlostepResultsTool(opts()), { id: 'batch_1' });
  assert.ok(agents.length >= 2);
  for (const agent of agents) assert.match(agent, /^olostep-mastra-tools\//);
});

test('the tools register on a Mastra agent', async () => {
  const agent = new Agent({ id: 'researcher', name: 'Researcher', instructions: 'Research.', model: 'openai/gpt-5-mini', tools: createOlostepTools() });
  const mastra = new Mastra({ agents: { researcher: agent }, logger: false });
  assert.equal(Object.keys(await mastra.getAgent('researcher').listTools()).length, 7);
});

test('createOlostepTools exposes every tool with a unique id', () => {
  const tools = createOlostepTools();
  assert.deepEqual(Object.keys(tools).sort(), [
    'olostepAnswer',
    'olostepBatch',
    'olostepCrawl',
    'olostepMap',
    'olostepResults',
    'olostepScrape',
    'olostepSearch',
  ]);
  assert.equal(new Set(Object.values(tools).map(tool => tool.id)).size, 7);
});
