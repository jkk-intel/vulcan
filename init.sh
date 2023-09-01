#!/bin/bash

if [[ -z "$SHARED_DIR" ]]; then
    echo "SHARED_DIR envinronment variable must be defined"
    exit 1
fi

cd "$SHARED_DIR"

if [[ ! -d "workflowlib" ]]; then
    {
        git clone https://github.com/jkk-intel/vulcan.git workflowlib
    } >/dev/null 2>&1
fi

cd workflowlib
git reset --hard origin/main
