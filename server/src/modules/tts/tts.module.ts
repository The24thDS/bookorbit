import { Module } from '@nestjs/common';

import { TtsClientService } from './tts-client.service';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';

@Module({
  controllers: [TtsController],
  providers: [TtsService, TtsClientService],
  exports: [TtsService],
})
export class TtsModule {}
