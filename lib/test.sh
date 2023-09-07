#!/bin/bash

echo "invoked test.sh"

CONST_DOCKER_HTTP_PROXY="http://proxy-chain.intel.com:911"
CONST_DOCKER_HTTPS_PROXY="http://proxy-chain.intel.com:911"
CONST_DOCKER_NO_PROXY="localhost,192.168.0.0/16,127.0.0.0/8,::1,intel.com"
export HTTP_PROXY="$CONST_DOCKER_HTTP_PROXY"
export HTTPS_PROXY="$CONST_DOCKER_HTTPS_PROXY"
export NO_PROXY="$CONST_DOCKER_NO_PROXY"

bash "$(__dir)/shell/toolchain/venv/pyenv.sh" \
    -r "$(__dir)/shell/toolchain/venv/requirements.txt"
