#!/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

bash "$(__dir)/shell/docker/build.sh"
