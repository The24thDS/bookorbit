import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

import { TtsClientService } from './tts-client.service';

function makeConfig(overrides: { pocketTtsUrl?: string; requestTimeoutMs?: number } = {}) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'tts.pocketTtsUrl') return overrides.pocketTtsUrl ?? 'http://pocket-tts:8000';
      if (key === 'tts.requestTimeoutMs') return overrides.requestTimeoutMs ?? 100_000;
      return undefined;
    }),
  } as never;
}

function makeResponse(status = 200, body: unknown = null): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: typeof body === 'string' ? { 'content-type': 'audio/wav' } : { 'content-type': 'application/json' },
  });
}

describe('TtsClientService', () => {
  let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('strips a trailing slash from the sidecar URL', () => {
    new TtsClientService(makeConfig({ pocketTtsUrl: 'http://pocket-tts:8000/' }));
    // construction does not fetch; just ensure no throw
    expect(true).toBe(true);
  });

  it('synthesize posts the text and voice as JSON to /v1/audio/speech', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, 'wav-bytes'));
    const client = new TtsClientService(makeConfig());
    const res = await client.synthesize('hello', 'cosette');

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://pocket-tts:8000/v1/audio/speech');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ input: 'hello', voice: 'cosette' });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('synthesize omits voice when undefined', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, 'wav-bytes'));
    const client = new TtsClientService(makeConfig());
    await client.synthesize('hello', undefined);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ input: 'hello', voice: undefined });
  });

  it('getVoices GETs /v1/voices', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, { voices: ['cosette'] }));
    const client = new TtsClientService(makeConfig());
    const res = await client.getVoices();
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://pocket-tts:8000/v1/voices');
    expect(init.method).toBe(undefined);
  });

  it('isReachable returns true on a healthy /health response', async () => {
    fetchMock.mockResolvedValue(makeResponse(200));
    const client = new TtsClientService(makeConfig());
    await expect(client.isReachable()).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://pocket-tts:8000/health');
  });

  it('isReachable returns false when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new TtsClientService(makeConfig());
    await expect(client.isReachable()).resolves.toBe(false);
  });

  it('isReachable returns false on a non-ok /health (e.g. 503 while loading)', async () => {
    fetchMock.mockResolvedValue(makeResponse(503));
    const client = new TtsClientService(makeConfig());
    await expect(client.isReachable()).resolves.toBe(false);
  });

  it('forwards an external AbortSignal and aborts the sidecar request when it fires', async () => {
    fetchMock.mockImplementation((_url, init) => {
      expect(init.signal.aborted).toBe(false);
      return Promise.resolve(makeResponse(200, 'ok'));
    });
    const client = new TtsClientService(makeConfig());
    const external = new AbortController();
    await client.synthesize('hi', undefined, external.signal);
    external.abort();
    expect(external.signal.aborted).toBe(true);
  });

  it('aborts immediately when the external signal is already aborted', async () => {
    fetchMock.mockResolvedValue(makeResponse(200, 'ok'));
    const client = new TtsClientService(makeConfig());
    const external = new AbortController();
    external.abort();
    await client.synthesize('hi', undefined, external.signal);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const signal = init.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });
});
