# TTS proxy gated behind a capability permission

The PocketTTS sidecar is a shared, CPU-bound inference service. The NestJS
proxy endpoints (`POST /api/v1/tts/synthesize`, `GET /api/v1/tts/voices`) are
gated behind a new `Permission.TtsAccess`, and accounts carrying
`Permission.DemoRestricted` are blocked.

We gate it (rather than leaving it open to any authenticated user) because an
ungated endpoint lets any user monopolize the shared inference CPU — a
resource-abuse vector that isn't visible from the "read aloud" feature name
alone. This mirrors the existing capability-permission pattern
(`HardcoverSync`, `KoreaderSync`, `OpdsAccess`, `NotificationAccess`).
