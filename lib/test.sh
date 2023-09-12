#!/bin/bash
source "$SHARED_DIR/bashlib.sh"

# setup_python -v 3.11 -f "shell/toolchain/venv/requirements.txt"
(
    cd "$(__dir)/node" && setup_node
    npm run build
);

