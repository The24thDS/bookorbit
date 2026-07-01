# BookOrbit

A self-hosted library and reading platform for ebooks, audiobooks, PDFs, and comics — organise, read, sync progress/annotations across surfaces, and enrich with metadata.

## Language

### People & credits

**Author**:
A person or organisation who wrote a book's text.
_Avoid_: Writer, creator

**Narrator**:
A real person who performed the audio narration of an audiobook — a book-credit, stored as metadata (the `narrator` domain). Distinct from a synthetic Voice.
_Avoid_: Reader (ambiguous with the app/UI reader), voiceover

### Reading & playback

**Reader**:
The in-app interface that renders a book for a human to read or listen (EPUB, PDF, CBZ, or audiobook). Also: a logged-in user interacting with the app.
_Avoid_: Viewer

**Reading session**:
A period of active reading/listening tracked for statistics (time, streaks), regardless of format.

**Voice**:
A synthetic timbre identifier offered by the TTS sidecar (e.g. `cosette`, `jean`, or a cloned voice id). Not a person and not a Narrator — a machine voice used for read-aloud and ebook-to-audiobook conversion.
_Avoid_: Narrator, speaker

**Block**:
The unit of text the read-aloud engine advances one at a time — a paragraph-level range yielded from the EPUB DOM.
