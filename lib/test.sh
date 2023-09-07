#!/bin/bash

echo "invoked test.sh"

eval "$(proxy_env_init)"
bash "$(__dir)/shell/toolchain/venv/pyenv.sh" \
    -r "$(__dir)/shell/toolchain/venv/requirements.txt"
