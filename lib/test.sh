#!/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

# bash "$(__dir)/node/build.sh"

setup_python -v 3.11 -f "$(__dir)/shell/toolchain/venv/requirements.txt"

# setup_node -f "$(__dir)/shell/toolchain/venv/package.json"


