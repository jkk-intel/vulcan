#!/bin/bash
source "$SHARED_DIR/bashlib.sh"

# setup_python -v 3.11 -f "shell/toolchain/venv/requirements.txt"
(
    cd "$(__dir)/node"
    NODE_PATH="$(setup_node)"
    rm -rf node_modules || true
    ln -s "$NODE_PATH/node_modules" node_modules
    use_nvm
    npm run build
);

