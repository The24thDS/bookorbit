import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { TtsService } from './tts.service';
import { TTS_INPUT_HARD_CAP } from './dto';

function makeConfig(overrides: { enabled?: boolean; maxChunkChars?: number } = {}) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'tts.enabled') return overrides.enabled ?? true;
      if (key === 'tts.maxChunkChars') return overrides.maxChunkChars ?? TTS_INPUT_HARD_CAP;
      return undefined;
    }),
  } as never;
}

function wavResponse(status = 200, body = 'audio-bytes'): Response {
  return new Response(body, { status, headers: { 'content-type': 'audio/wav' } });
}

interface ClientOverrides {
  synthesize?: ReturnType<typeof vi.fn>;
  getVoices?: ReturnType<typeof vi.fn>;
  isReachable?: ReturnType<typeof vi.fn>;
}

function makeService(overrides: { enabled?: boolean; maxChunkChars?: number; client?: ClientOverrides } = {}) {
  const config = makeConfig({ enabled: overrides.enabled, maxChunkChars: overrides.maxChunkChars });
  const client = {
    synthesize: overrides.client?.synthesize ?? vi.fn(),
    getVoices: overrides.client?.getVoices ?? vi.fn(),
    isReachable: overrides.client?.isReachable ?? vi.fn(),
  } as never;
  const service = new TtsService(config, client);
  return { service, client };
}

describe('TtsService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('synthesize', () => {
    it('throws 503 ServiceUnavailable when disabled', async () => {
      const { service, client } = makeService({ enabled: false });
      await expect(service.synthesize('hi', undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(client.synthesize).not.toHaveBeenCalled();
    });

    it('throws 400 when input exceeds the configured cap', async () => {
      const { service, client } = makeService({ maxChunkChars: 10 });
      await expect(service.synthesize('x'.repeat(11), undefined)).rejects.toBeInstanceOf(BadRequestException);
      expect(client.synthesize).not.toHaveBeenCalled();
    });

    it('passes through the sidecar Response when ok', async () => {
      const synthesize = vi.fn().mockResolvedValue(wavResponse());
      const { service } = makeService({ client: { synthesize } });
      const res = await service.synthesize('hello', 'cosette');
      expect(res.ok).toBe(true);
      expect(synthesize).toHaveBeenCalledWith('hello', 'cosette', undefined);
    });

    it('returns a 503 when the sidecar responds 503 (loading)', async () => {
      const synthesize = vi.fn().mockResolvedValue(wavResponse(503));
      const { service } = makeService({ client: { synthesize } });
      await expect(service.synthesize('hello', undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('returns a 400 when the sidecar rejects the request (e.g. 400 bad voice)', async () => {
      const synthesize = vi.fn().mockResolvedValue(wavResponse(400));
      const { service } = makeService({ client: { synthesize } });
      await expect(service.synthesize('hello', 'no-such-voice')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns a 503 when the fetch to the sidecar throws', async () => {
      const synthesize = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const { service } = makeService({ client: { synthesize } });
      await expect(service.synthesize('hello', undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('re-throws AbortError (client disconnect) instead of converting to 503', async () => {
      const abortError = new DOMException('aborted', 'AbortError');
      const synthesize = vi.fn().mockRejectedValue(abortError);
      const { service } = makeService({ client: { synthesize } });
      await expect(service.synthesize('hello', undefined)).rejects.toThrow(abortError);
    });
  });

  describe('getVoices', () => {
    it('throws 503 when disabled', async () => {
      const { service, client } = makeService({ enabled: false });
      await expect(service.getVoices()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(client.getVoices).not.toHaveBeenCalled();
    });

    it('returns parsed JSON when the sidecar is reachable', async () => {
      const getVoices = vi.fn().mockResolvedValue(new Response(JSON.stringify({ voices: ['cosette'] }), { status: 200 }));
      const { service } = makeService({ client: { getVoices } });
      await expect(service.getVoices()).resolves.toEqual({ voices: ['cosette'] });
    });

    it('returns 503 when the fetch throws', async () => {
      const getVoices = vi.fn().mockRejectedValue(new Error('network down'));
      const { service } = makeService({ client: { getVoices } });
      await expect(service.getVoices()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('getStatus', () => {
    it('returns enabled=false with the effective cap, without contacting the sidecar when disabled', async () => {
      const isReachable = vi.fn();
      const { service } = makeService({ enabled: false, client: { isReachable } });
      await expect(service.getStatus()).resolves.toEqual({
        enabled: false,
        reachable: false,
        maxChunkChars: TTS_INPUT_HARD_CAP,
      });
      expect(isReachable).not.toHaveBeenCalled();
    });

    it('returns the sidecar reachability when enabled', async () => {
      const isReachable = vi.fn().mockResolvedValue(true);
      const { service } = makeService({ client: { isReachable } });
      await expect(service.getStatus()).resolves.toEqual({
        enabled: true,
        reachable: true,
        maxChunkChars: TTS_INPUT_HARD_CAP,
      });
      expect(isReachable).toHaveBeenCalled();
    });

    it('reports the configured lower cap clamped to the hard cap', async () => {
      const isReachable = vi.fn().mockResolvedValue(true);
      const { service } = makeService({ maxChunkChars: 10, client: { isReachable } });
      await expect(service.getStatus()).resolves.toEqual({
        enabled: true,
        reachable: true,
        maxChunkChars: 10,
      });
    });
  });
});
