import { afterEach, describe, it, expect, vi } from 'vitest';
import { PROVIDERS, ProviderError, canSeeImages, createChat, isPlausibleKey, isPlausibleModel, listModels, localBase, pickModel, scrub, stripThinking } from './providers';

const KEY = 'sk-test-0123456789abcdef';

type Body = Record<string, unknown> & { generationConfig?: Record<string, unknown> };
type Call = { url: string; init: RequestInit; body: Body };

function fakeFetch(...responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return typeof next === 'function' ? next() : next;
  });
  return { f: f as unknown as typeof fetch, calls };
}

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const openaiReply = (text: string) => jsonRes({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

const REQ = { system: 'sys', user: 'hello', json: true, maxTokens: 500, temperature: 0.7 };

describe('keys and models', () => {
  it('accepts keys that look like keys', () => {
    expect(isPlausibleKey(KEY)).toBe(true);
    expect(isPlausibleKey('short')).toBe(false);
    expect(isPlausibleKey('has space in it 12345')).toBe(false);
    expect(isPlausibleKey('line\nbreak12345')).toBe(false);
  });

  it('accepts model ids, and nothing that could leave the path', () => {
    expect(isPlausibleModel('openai/gpt-5-mini')).toBe(true);
    expect(isPlausibleModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isPlausibleModel('../../v1/files')).toBe(false);
    expect(isPlausibleModel('gemini?key=x')).toBe(false);
  });

  it('scrubs the key, and anything shaped like one', () => {
    expect(scrub(`bad key ${KEY} here`, KEY)).toBe('bad key [key] here');
    expect(scrub('leaked AIzaSyA1234567890abcdefghijklmn')).toBe('leaked [key]');
  });

  it('lists the providers, the demo only outside production', () => {
    expect(PROVIDERS.map(p => p.id)).toEqual(expect.arrayContaining(['openai', 'anthropic', 'google', 'openrouter']));
    expect(PROVIDERS.every(p => p.needsKey === (p.id !== 'demo' && p.id !== 'local'))).toBe(true);
  });
});

describe('createChat', () => {
  it('speaks OpenAI: JSON mode, completion tokens, no temperature for reasoning models', async () => {
    const { f, calls } = fakeFetch(openaiReply('{"a":1}'));
    const out = await createChat('openai', KEY, 'gpt-5-mini', f)(REQ);
    expect(out).toEqual({ text: '{"a":1}', input: 10, output: 5 });
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toMatchObject({ model: 'gpt-5-mini', response_format: { type: 'json_object' } });
    expect(calls[0].body.temperature).toBeUndefined();
    expect(calls[0].body.reasoning_effort).toBe('low');
    expect(calls[0].body.max_completion_tokens as number).toBeGreaterThanOrEqual(500);
  });

  it('speaks Anthropic', async () => {
    const { f, calls } = fakeFetch(jsonRes({ content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 1 } }));
    const out = await createChat('anthropic', KEY, 'claude-haiku-4-5-20251001', f)(REQ);
    expect(out.text).toBe('hi');
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe(KEY);
    expect(h['anthropic-version']).toBeTruthy();
    expect(calls[0].body).toMatchObject({ system: 'sys', max_tokens: 500, temperature: 0.7, messages: [{ role: 'user', content: 'hello' }] });
  });

  it('speaks Gemini, with the key in a header and never in the URL', async () => {
    const { f, calls } = fakeFetch(jsonRes({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{}' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } }));
    const out = await createChat('google', KEY, 'gemini-2.5-flash', f)(REQ);
    expect(out.text).toBe('{}');
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(calls[0].url).not.toContain(KEY);
    expect((calls[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    expect(calls[0].body.generationConfig?.responseMimeType).toBe('application/json');
  });

  it('drops a field the model refuses and tries again', async () => {
    const { f, calls } = fakeFetch(
      jsonRes({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }, 400),
      openaiReply('ok'),
    );
    const chat = createChat('groq', KEY, 'some-model', f);
    expect((await chat(REQ)).text).toBe('ok');
    expect(calls[0].body.temperature).toBe(0.7);
    expect(calls[1].body.temperature).toBeUndefined();
  });

  it('drops reasoning effort for a model that will not take it', async () => {
    const { f, calls } = fakeFetch(
      jsonRes({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }, 400),
      openaiReply('ok'),
    );
    expect((await createChat('openai', KEY, 'gpt-5-chat-latest', f)(REQ)).text).toBe('ok');
    expect(calls[0].body.reasoning_effort).toBe('low');
    expect(calls[1].body.reasoning_effort).toBeUndefined();
  });

  it('retries once when the provider is busy', async () => {
    const { f, calls } = fakeFetch(jsonRes({ error: { message: 'slow down' } }, 429, { 'retry-after': '0' }), openaiReply('ok'));
    expect((await createChat('deepseek', KEY, 'deepseek-chat', f)(REQ)).text).toBe('ok');
    expect(calls).toHaveLength(2);
  }, 10_000);

  it('fails at once on a rejected key, without the key in the message', async () => {
    const { f, calls } = fakeFetch(jsonRes({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401));
    const err = await createChat('openai', KEY, 'gpt-5-mini', f)(REQ).catch(e => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('auth');
    expect(err.message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
  });

  it('tells quota from rate limits', async () => {
    const { f } = fakeFetch(jsonRes({ error: { message: 'You exceeded your current quota' } }, 429));
    const err = await createChat('openai', KEY, 'gpt-5-mini', f)(REQ).catch(e => e);
    expect(err.code).toBe('quota');
  });
});

describe('listModels', () => {
  it('keeps chat models and puts the suggested ones first', async () => {
    const { f } = fakeFetch(jsonRes({ data: [{ id: 'whisper-1' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini' }, { id: 'gpt-5-mini' }, { id: 'aaa-chat' }] }));
    const { models } = await listModels('openai', KEY, f);
    expect(models.map(m => m.id)).toEqual(['gpt-5-mini', 'gpt-4o-mini', 'aaa-chat']);
    expect(pickModel('openai', models)).toBe('gpt-5-mini');
  });

  it('leaves out the OpenAI models only its Responses API serves', async () => {
    const { f } = fakeFetch(jsonRes({ data: ['gpt-5', 'gpt-5-pro', 'o3-pro-2025-06-10', 'gpt-5-codex', 'codex-mini-latest', 'o3-deep-research', 'sora-2', 'o3'].map(id => ({ id })) }));
    const { models } = await listModels('openai', KEY, f);
    expect(models.map(m => m.id).sort()).toEqual(['gpt-5', 'o3']);
  });

  it('checks an OpenRouter key on its own endpoint', async () => {
    const { f, calls } = fakeFetch(jsonRes({ error: { message: 'No auth credentials found' } }, 401));
    await expect(listModels('openrouter', KEY, f)).rejects.toMatchObject({ code: 'auth' });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/key');
  });

  it('falls back to the known names when a provider cannot list', async () => {
    const { f } = fakeFetch(jsonRes({}, 404));
    const out = await listModels('qwen', KEY, f);
    expect(out.listed).toBe(false);
    expect(out.models[0].id).toBe('qwen-plus');
  });
});

describe('local model', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('takes its address from the server environment only, and only a plain http(s) URL', () => {
    expect(localBase({})).toBe('');
    expect(localBase({ OSIRIS_LOCAL_LLM_URL: 'http://localhost:11434/v1/' })).toBe('http://localhost:11434/v1');
    expect(localBase({ OSIRIS_LOCAL_LLM_URL: 'file:///etc/passwd' })).toBe('');
    expect(localBase({ OSIRIS_LOCAL_LLM_URL: 'http://user:pw@host:1234/v1' })).toBe('');
    expect(localBase({ OSIRIS_LOCAL_LLM_URL: 'not a url' })).toBe('');
  });

  it('is offered without a key', () => {
    expect(PROVIDERS.find(p => p.id === 'local')).toMatchObject({ needsKey: false, concurrency: 1 });
  });

  it('explains how to configure it when no address is set', async () => {
    vi.stubEnv('OSIRIS_LOCAL_LLM_URL', '');
    const { f, calls } = fakeFetch();
    const err = await createChat('local', '', 'qwen3.5:9b', f)(REQ).catch(e => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/OSIRIS_LOCAL_LLM_URL/);
    expect(calls).toHaveLength(0);
  });

  it('speaks OpenAI to the configured address, with no Authorization header when there is no key', async () => {
    vi.stubEnv('OSIRIS_LOCAL_LLM_URL', 'http://localhost:11434/v1');
    vi.stubEnv('OSIRIS_LOCAL_LLM_KEY', '');
    const { f, calls } = fakeFetch(openaiReply('{"a":1}'));
    const out = await createChat('local', '', 'qwen3.5:9b', f)(REQ);
    expect(out.text).toBe('{"a":1}');
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(calls[0].body).toMatchObject({ model: 'qwen3.5:9b', max_tokens: 500, response_format: { type: 'json_object' } });
  });

  it('sends the server key when the caller gives none (OmniRoute, LM Studio)', async () => {
    vi.stubEnv('OSIRIS_LOCAL_LLM_URL', 'http://localhost:20128/v1');
    vi.stubEnv('OSIRIS_LOCAL_LLM_KEY', 'omni-key-123456');
    const { f, calls } = fakeFetch(openaiReply('ok'));
    await createChat('local', '', 'auto', f)(REQ);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer omni-key-123456');
  });

  it('strips inline thinking from a reasoning model', async () => {
    vi.stubEnv('OSIRIS_LOCAL_LLM_URL', 'http://localhost:11434/v1');
    const { f } = fakeFetch(openaiReply('<think>let me consider</think>\n{"a":1}'));
    expect((await createChat('local', '', 'qwen3.5:9b', f)(REQ)).text).toBe('{"a":1}');
    expect(stripThinking('<think>ran out of tokens')).toBe('');
    expect(stripThinking('{"plain":true}')).toBe('{"plain":true}');
  });

  it('says Ollama may not be running when it cannot connect', async () => {
    vi.stubEnv('OSIRIS_LOCAL_LLM_URL', 'http://localhost:11434/v1');
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await createChat('local', '', 'qwen3.5:9b', f)({ ...REQ, timeoutMs: 20_000 }).catch(e => e);
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/Ollama running/);
  }, 10_000);

  it('lists the installed models without a key', async () => {
    vi.stubEnv('OSIRIS_LOCAL_LLM_URL', 'http://localhost:11434/v1');
    const { f, calls } = fakeFetch(jsonRes({ data: [{ id: 'llama3.2:latest' }, { id: 'qwen3.5:9b' }, { id: 'nomic-embed-text:latest' }] }));
    const { models, listed } = await listModels('local', '', f);
    expect(listed).toBe(true);
    expect(calls[0].url).toBe('http://localhost:11434/v1/models');
    expect(models.map(m => m.id)).toEqual(['qwen3.5:9b', 'llama3.2:latest']);
    expect(pickModel('local', models)).toBe('qwen3.5:9b');
  });

  it('guesses which local models can see pictures', () => {
    expect(canSeeImages('local', 'gemma3:12b')).toBe(true);
    expect(canSeeImages('local', 'llava:7b')).toBe(true);
    expect(canSeeImages('local', 'llama3.2-vision')).toBe(true);
    expect(canSeeImages('local', 'qwen2.5vl:7b')).toBe(true);
    expect(canSeeImages('local', 'qwen3.5:9b')).toBe(false);
    expect(canSeeImages('local', 'llama3.2')).toBe(false);
  });
});
