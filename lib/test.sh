#!/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

bash "$(__dir)/shell/toolchain/venv/python.sh" \
    -v 3.11 -f "$(__dir)/shell/toolchain/venv/requirements.txt"

bash "$(__dir)/shell/toolchain/venv/node.sh" \
    -f "$(__dir)/shell/toolchain/venv/package.json"
