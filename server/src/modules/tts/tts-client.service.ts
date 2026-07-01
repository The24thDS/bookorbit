import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Thin HTTP surface to the PocketTTS sidecar. All sidecar traffic flows through
 * here so the rest of the app never touches the sidecar origin directly
 * (avoids app CSP writes, see docs/POCKET_TTS_INTEGRATION.md).
 *
 * Uses the global `fetch` — no extra HTTP lib. Responses are returned un-buffered
 * so the caller can stream the sidecar's chunked WAV straight to the client.
 */
@Injectable()
export class TtsClientService {
  private readonly logger = new Logger(TtsClientService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('tts.pocketTtsUrl') ?? 'http://pocket-tts:8000').replace(/\/$/, '');
    this.timeoutMs = config.get<number>('tts.requestTimeoutMs') ?? 60_000;
  }

  /**
   * Synthesize plain text → streaming WAV (`POST /v1/audio/speech`).
   * The returned Response is un-consumed; the caller pipes `response.body` onward.
   */
  async synthesize(input: string, voice: string | undefined, signal?: AbortSignal): Promise<Response> {
    const body = JSON.stringify({ input, voice: voice ?? undefined });
    return this.fetchWithTimeout(
      `${this.baseUrl}/v1/audio/speech`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      signal,
    );
  }

  /** List sidecar voices (`GET /v1/voices`). Returns the un-consumed Response. */
  async getVoices(signal?: AbortSignal): Promise<Response> {
    return this.fetchWithTimeout(`${this.baseUrl}/v1/voices`, {}, signal);
  }

  /** Readiness probe (`GET /health`). Resolves `true` when the sidecar reports ready. */
  async isReachable(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/health`, {}, signal, { withTimeout: false });
      return res.ok;
    } catch (err) {
      this.logger.debug(`[tts.client] isReachable=false ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
    opts: { withTimeout?: boolean } = { withTimeout: true },
  ): Promise<Response> {
    const controller = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    if (opts.withTimeout && Number.isFinite(this.timeoutMs) && this.timeoutMs > 0) {
      timers.push(setTimeout(() => controller.abort(), this.timeoutMs));
    }

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      timers.forEach(clearTimeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
