# syntax=docker/dockerfile:1
#
# PocketTTS sidecar — bytetrie/pocket-tts-deno
#
# A Deno HTTP server running the kyutai pocket-tts ONNX (INT8) models on CPU.
# No official image exists upstream; this bakes the ~190 MB of models and the
# Deno source into a single self-contained image.
#
# Build:  docker compose build pocket-tts
# Run:    docker compose up pocket-tts
# Verify: curl -s http://127.0.0.1:8001/v1/audio/speech \
#           -H 'Content-Type: application/json' \
#           -d '{"input":"Hello world!","voice":"cosette"}' > speech.wav
#
# The server resolves all data files relative to server.ts (`BASE_DIR`), so the
# whole working tree must stay co-located — we COPY the checkout wholesale.

ARG DENO_IMAGE=denoland/deno:debian-2.9.1

# ─── Builder: fetch source + models, pre-cache the Deno dependency graph ───────
FROM ${DENO_IMAGE} AS builder

# git-lfs is needed to pull the ~190 MB of ONNX models tracked via LFS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git-lfs ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git lfs install

WORKDIR /app

# Shallow clone with LFS: gets server.ts, sentencepiece.{ts,wasm}, deno.json,
# tokenizer.model, voices.bin and the five onnx/*.onnx models.
RUN git clone --depth 1 https://github.com/bytetrie/pocket-tts-deno.git . \
 && git lfs pull

# Pre-fetch onnxruntime-node (npm import, nodeModulesDir: "auto" in deno.json)
# and compile the TS module graph so first start is fast and offline-safe.
RUN deno cache server.ts

# ─── Runtime ───────────────────────────────────────────────────────────────────
FROM ${DENO_IMAGE} AS runtime

# onnxruntime-node's native .node binaries link against libgomp (OpenMP) and
# libstdc++; the slim Deno image omits libgomp. Install it so the ONNX runtime
# can load its native kernels.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the checked-out source + models, plus the prebuilt Deno npm cache so
# onnxruntime-node is available without a network fetch at runtime.
COPY --from=builder /app ./
COPY --from=builder /deno-dir /deno-dir

EXPOSE 8000

# Deno invokes the serve task with the permissions the upstream `deno task serve`
# promises: read (models), net (HTTP), sys (core count for thread tuning),
# ffi (the onnxruntime-node native addon), env (optional).
#
# `--port 8000` fixes the listen port; Deno.serve binds 0.0.0.0 by default so
# the container is reachable on the compose network as http://pocket-tts:8000.
CMD ["deno", "run", \
     "--allow-read", "--allow-net", "--allow-sys", "--allow-ffi", "--allow-env", \
     "server.ts", "--port", "8000"]