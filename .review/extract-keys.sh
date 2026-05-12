#!/bin/bash
set -e
SRC=~/.hermes/.env
OUT="$1"

gem=$(grep '^GEMINI_API_KEY=' "$SRC" | head -1 | cut -d= -f2-)
oai=$(grep '^VOICE_TOOLS_OPENAI_KEY=' "$SRC" | head -1 | cut -d= -f2-)
ant=$(grep '^ANTHROPIC_TOKEN=' "$SRC" | head -1 | cut -d= -f2-)

cat > "$OUT" <<EOF
GOOGLE_API_KEY=$gem
OPENAI_API_KEY=$oai
ANTHROPIC_API_KEY=$ant
MODEL_PRIMARY=gemini-2.0-flash-001
MODEL_FALLBACK=gpt-4o-mini
VISION_TIMEOUT_MS=4500
RATE_LIMIT_PER_MIN=60
MAX_BATCH_SIZE=300
EOF

echo "gem-prefix=${gem:0:6}"
echo "gem-len=${#gem}"
echo "oai-prefix=${oai:0:6}"
echo "oai-len=${#oai}"
echo "ant-prefix=${ant:0:6}"
echo "ant-len=${#ant}"
