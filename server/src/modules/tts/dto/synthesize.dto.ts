import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Hard ceiling for a single read-aloud request. The effective per-request cap
 * is the configured `tts.maxChunkChars` (which may be lower); this decorator
 * is a static hard floor that the global ValidationPipe enforces.
 */
export const TTS_INPUT_HARD_CAP = 4000;

export class SynthesizeDto {
  @IsString()
  @MaxLength(TTS_INPUT_HARD_CAP, { message: 'input exceeds the maximum length (4000 chars)' })
  input!: string;

  @IsOptional()
  @IsString()
  voice?: string;
}
