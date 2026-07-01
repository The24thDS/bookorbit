import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TtsClientService } from './tts-client.service';
import { TTS_INPUT_HARD_CAP } from './dto';

export interface TtsStatus {
  enabled: boolean;
  reachable: boolean;
  /** Effective per-request input cap the client must split under. */
  maxChunkChars: number;
}

/**
 * Orchestrates read-aloud requests against the PocketTTS sidecar.
 *
 * Both proxy endpoints share the same gating: a 503 (not a 500) when TTS is
 * disabled in config or the sidecar is unreachable, so the browser can treat
 * "feature off" uniformly. The per-request character cap is enforced here
 * against the configured value (clamped to the DTO hard cap).
 */
@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  private readonly enabled: boolean;
  private readonly maxChunkChars: number;

  constructor(
    private readonly config: ConfigService,
    private readonly client: TtsClientService,
  ) {
    this.enabled = this.config.get<boolean>('tts.enabled') ?? false;
    this.maxChunkChars = this.config.get<number>('tts.maxChunkChars') ?? TTS_INPUT_HARD_CAP;
  }

  async synthesize(input: string, voice: string | undefined, signal?: AbortSignal): Promise<Response> {
    this.assertEnabled();
    this.assertCap(input);

    let response: Response;
    try {
      response = await this.client.synthesize(input, voice, signal);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      this.logger.warn(`[tts.service] synthesize: sidecar unreachable (${this.describe(err)})`);
      throw new ServiceUnavailableException('TTS sidecar is unavailable');
    }

    if (response.status === 503) {
      // Sidecar still loading models.
      throw new ServiceUnavailableException('TTS sidecar is warming up');
    }
    if (!response.ok) {
      throw new BadRequestException(`TTS sidecar rejected the request (${response.status})`);
    }

    return response;
  }

  async getVoices(signal?: AbortSignal): Promise<unknown> {
    this.assertEnabled();
    let response: Response;
    try {
      response = await this.client.getVoices(signal);
    } catch (err) {
      this.logger.warn(`[tts.service] voices: sidecar unreachable (${this.describe(err)})`);
      throw new ServiceUnavailableException('TTS sidecar is unavailable');
    }
    if (!response.ok) throw new ServiceUnavailableException('TTS sidecar is unavailable');
    return response.json();
  }

  async getStatus(): Promise<TtsStatus> {
    // Report the effective cap (the same value assertCap enforces) so the
    // client knows how to split overlong blocks. Returned even when the sidecar
    // is down/disabled, so a configured lower cap still constrains splitting.
    const cap = Math.min(this.maxChunkChars, TTS_INPUT_HARD_CAP);
    if (!this.enabled) return { enabled: false, reachable: false, maxChunkChars: cap };
    const reachable = await this.client.isReachable();
    return { enabled: true, reachable, maxChunkChars: cap };
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException('TTS is disabled');
  }

  private assertCap(input: string): void {
    const effectiveCap = Math.min(this.maxChunkChars, TTS_INPUT_HARD_CAP);
    if (typeof input !== 'string' || input.length > effectiveCap) {
      throw new BadRequestException(`input exceeds the per-request character cap (${effectiveCap})`);
    }
  }

  private describe(err: unknown): string {
    return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
  }
}
