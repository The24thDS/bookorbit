import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { TtsController } from './tts.controller';
import { SynthesizeDto, TTS_INPUT_HARD_CAP } from './dto';

function makeWavResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('RIFF…wav'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'audio/wav' } });
}

function makeReq() {
  return { raw: new EventEmitter() } as never;
}

function makeReply() {
  const headers: Record<string, string> = {};
  const send = vi.fn();
  const reply = {
    header: vi.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    send,
  };
  return { reply: reply as never, headers };
}

describe('TtsController', () => {
  type SynthesizeFn = (input: string, voice: string | undefined, signal: AbortSignal) => Promise<Response>;
  let service: {
    synthesize: Mock<SynthesizeFn>;
    getVoices: Mock<() => Promise<unknown>>;
    getStatus: Mock<() => Promise<unknown>>;
  };
  let controller: TtsController;

  beforeEach(() => {
    vi.clearAllMocks();
    service = {
      synthesize: vi.fn<SynthesizeFn>(),
      getVoices: vi.fn<() => Promise<unknown>>(),
      getStatus: vi.fn<() => Promise<unknown>>(),
    };
    controller = new TtsController(service as never);
  });

  describe('synthesize', () => {
    it('streams the sidecar WAV straight through without buffering and sets audio/wav content type', async () => {
      service.synthesize.mockResolvedValue(makeWavResponse());
      const req = makeReq();
      const { reply, headers } = makeReply();
      const dto = new SynthesizeDto();
      dto.input = 'hello world';
      dto.voice = 'cosette';

      await controller.synthesize(dto, req, reply);

      expect(service.synthesize).toHaveBeenCalledWith('hello world', 'cosette', expect.any(AbortSignal));
      expect(headers['Content-Type']).toBe('audio/wav');
      expect(headers['Cache-Control']).toBe('no-store');
      expect(reply.send).toHaveBeenCalledTimes(1);
      expect(reply.send.mock.calls[0][0]).toBeInstanceOf(Readable);
    });

    it('still renders a reply when the body is unexpectedly absent', async () => {
      service.synthesize.mockResolvedValue(new Response(null, { status: 200 }));
      const req = makeReq();
      const { reply } = makeReply();
      const dto = new SynthesizeDto();
      dto.input = 'x';
      await controller.synthesize(dto, req, reply);
      expect(reply.send).toHaveBeenCalledTimes(1);
    });

    it('passes an AbortSignal through to the service', async () => {
      let captured!: AbortSignal;
      service.synthesize.mockImplementation((_input: string, _voice: string | undefined, signal: AbortSignal) => {
        captured = signal;
        return Promise.resolve(makeWavResponse());
      });
      const req = makeReq();
      const { reply } = makeReply();
      const dto = new SynthesizeDto();
      dto.input = 'hi';
      await controller.synthesize(dto, req, reply);
      expect(captured).toBeInstanceOf(AbortSignal);
    });

    it('aborts the in-flight sidecar request when the client connection closes', async () => {
      let captured!: AbortSignal;
      let resolveSynth!: (v: Response) => void;
      service.synthesize.mockImplementation((_input: string, _voice: string | undefined, signal: AbortSignal) => {
        captured = signal;
        return new Promise<Response>((resolve) => {
          resolveSynth = resolve;
        });
      });
      const req = makeReq();
      const { reply } = makeReply();
      const dto = new SynthesizeDto();
      dto.input = 'hi';
      const synthPromise = controller.synthesize(dto, req, reply);
      // Simulate the client disconnecting mid-flight.
      req.raw.emit('close');
      expect(captured.aborted).toBe(true);
      resolveSynth(makeWavResponse());
      await synthPromise;
    });

    it('removes the close listener after the request resolves', async () => {
      service.synthesize.mockResolvedValue(makeWavResponse());
      const req = makeReq();
      const { reply } = makeReply();
      const dto = new SynthesizeDto();
      dto.input = 'hi';
      await controller.synthesize(dto, req, reply);
      // Controller unhooks the close listener once the request resolves so the
      // (long-lived) reply isn't tied to stale abort wiring.
      expect(req.raw.listenerCount('close')).toBe(0);
    });

    it('exposes the TTS input hard cap for the DTO decorator', () => {
      expect(TTS_INPUT_HARD_CAP).toBe(4000);
      const dto = new SynthesizeDto();
      dto.input = 'x'.repeat(TTS_INPUT_HARD_CAP + 1);
      expect(dto.input.length).toBeGreaterThan(TTS_INPUT_HARD_CAP);
    });
  });

  describe('getVoices', () => {
    it('delegates to the service', async () => {
      service.getVoices.mockResolvedValue({ voices: ['cosette', 'jean'] });
      await expect(controller.getVoices()).resolves.toEqual({ voices: ['cosette', 'jean'] });
      expect(service.getVoices).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('delegates to the service', async () => {
      service.getStatus.mockResolvedValue({ enabled: true, reachable: true });
      await expect(controller.getStatus()).resolves.toEqual({ enabled: true, reachable: true });
    });
  });
});
