#!/usr/bin/env python
"""Invoke Hermes CLI with a long prompt loaded from file, bypassing shell quoting."""
import subprocess
import sys
import pathlib

prompt_file = pathlib.Path(__file__).parent / "hermes-wave32-closure-prompt.txt"
output_file = pathlib.Path(__file__).parent / "hermes-wave32-closure-out.txt"

with open(prompt_file, "r", encoding="utf-8") as f:
    q = f.read()

result = subprocess.run(
    [r"C:\Users\xande\.local\bin\hermes.cmd", "chat", "-q", q, "-Q"],
    capture_output=True,
    text=True,
    timeout=300,
)
output = result.stdout
with open(output_file, "w", encoding="utf-8") as f:
    f.write(output)
sys.stdout.write(output)
if result.returncode != 0:
    sys.stderr.write("\n--- stderr ---\n" + result.stderr)
    sys.exit(result.returncode)
