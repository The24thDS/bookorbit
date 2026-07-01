# Read-aloud counts as reading-session activity

While live TTS read-aloud is playing in the EPUB reader, the `useReadingSession`
is fed `onActivity()` (per block advance + periodic tick), so synthetic
narration accrues reading time, streaks, and achievements — the same as playing
a real audiobook.

We count it because read-aloud is the accessibility fallback for books with no
audiobook edition: to the user, listening to the synth-narrated text *is*
reading the book. The audiobook reader already establishes the precedent that
listening counts as reading activity, so diverging here would be inconsistent.
The 5-minute idle timeout backstops stalled generation, and we accept the same
"walk away with audio playing" inflation risk the audiobook reader already
carries rather than special-casing synth playback.
