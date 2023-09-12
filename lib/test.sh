#!/bin/bash
source "$SHARED_DIR/bashlib.sh"

# setup_python -v 3.11 -f "shell/toolchain/venv/requirements.txt"
(
    cd "$(__dir)/node"
    export NODE_PATH="$(setup_node)"
    use_nvm
    npm run build
);

