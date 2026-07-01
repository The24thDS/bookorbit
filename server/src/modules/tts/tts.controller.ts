import { Controller, Get, Post, Body, Res, Req } from '@nestjs/common';
import { Permission } from '@bookorbit/types';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ForbidPermission } from '../../common/decorators/forbid-permission.decorator';
import { SynthesizeDto } from './dto';
import { TtsService } from './tts.service';

@Controller('tts')
export class TtsController {
  constructor(private readonly ttsService: TtsService) {}

  /**
   * Stream a WAV straight through from the sidecar to the browser.
   * The browser never talks to the sidecar directly (app CSP would block it;
   * see docs/POCKET_TTS_INTEGRATION.md). A client disconnect is forwarded to the
   * sidecar via an AbortController so the CPU-bound inference stops promptly.
   */
  @Post('synthesize')
  @RequirePermission(Permission.TtsAccess)
  @ForbidPermission(Permission.DemoRestricted, 'Demo accounts cannot use read-aloud')
  async synthesize(@Body() dto: SynthesizeDto, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.raw.on('close', onClose);

    let response: Response;
    try {
      response = await this.ttsService.synthesize(dto.input, dto.voice, controller.signal);
    } finally {
      req.raw.off('close', onClose);
    }

    reply.header('Content-Type', 'audio/wav');
    reply.header('Cache-Control', 'no-store');
    // Pipe the sidecar's web stream straight through (no buffering). If the body
    // is missing (unexpected), close the reply cleanly.
    if (response.body) {
      reply.send(Readable.fromWeb(response.body as never));
    } else {
      reply.send();
    }
  }

  /** Proxy the sidecar voice list to the browser. */
  @Get('voices')
  @RequirePermission(Permission.TtsAccess)
  @ForbidPermission(Permission.DemoRestricted, 'Demo accounts cannot use read-aloud')
  async getVoices() {
    return this.ttsService.getVoices();
  }

  /**
   * Feature availability for the client: drives "Read aloud" button visibility.
   * Authenticated but not gated behind TtsAccess — any logged-in user can learn
   * whether the feature is on.
   */
  @Get('status')
  getStatus() {
    return this.ttsService.getStatus();
  }
}
