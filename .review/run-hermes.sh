#!/bin/bash
# Usage: run-hermes.sh <prompt-file> <out-file>
PROMPT="$(cat "$1")"
hermes chat -Q -q "$PROMPT" > "$2" 2>&1
echo "EXIT=$?"
