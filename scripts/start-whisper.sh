#!/bin/bash
# Локальное распознавание речи для Call Interpreter.
#
# Модель: ~/whisper-models/ggml-large-v3-turbo.bin
#   curl -L -O https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
#
# Важно: --inference-path обязателен. По умолчанию whisper-server отдаёт /inference,
# а расширение (как и OpenAI SDK) ходит в /v1/audio/transcriptions.
set -euo pipefail

MODEL="${WHISPER_MODEL:-$HOME/whisper-models/ggml-large-v3-turbo.bin}"
PORT="${WHISPER_PORT:-8080}"
THREADS="${WHISPER_THREADS:-8}"

if [ ! -f "$MODEL" ]; then
  echo "Не найдена модель: $MODEL" >&2
  echo "Скачайте: curl -L -O https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" >&2
  exit 1
fi

if ! command -v whisper-server >/dev/null 2>&1; then
  echo "Нет whisper-server. Установите: brew install whisper.cpp" >&2
  exit 1
fi

echo "Модель: $MODEL"
echo "Слушаю на http://127.0.0.1:$PORT/v1/audio/transcriptions"
echo "В настройках расширения: Base URL http://127.0.0.1:$PORT/v1, ключ и модель — любые."

exec whisper-server \
  -m "$MODEL" \
  --host 127.0.0.1 \
  --port "$PORT" \
  -t "$THREADS" \
  -l en \
  --inference-path /v1/audio/transcriptions
