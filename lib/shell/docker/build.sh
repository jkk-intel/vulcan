#/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

setup_node -f "$(__dir)/shell/toolchain/venv/package.json"
use_nvm
npm i -g typescript


