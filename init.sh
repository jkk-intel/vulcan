#!/bin/bash

if [[ -z "$SHARED_DIR" ]]; then
    echo "SHARED_DIR envinronment variable must be defined"
    exit 1
fi

cd "$SHARED_DIR"

{
    rm -rf $GITHUB_WORKSPACE/*
    if [[ ! -d "workflowlib" ]]; then
        git clone https://github.com/jkk-intel/vulcan.git workflowlib
    fi
    
    cd workflowlib
    git fetch origin
    git reset --hard origin/main
    git pull
    mkdir -p $GITHUB_WORKSPACE/.github/actions/
    cp -r "$(pwd)/actions/"* "$GITHUB_WORKSPACE/.github/actions/"
} >>"$INSTALL_DIR/workflowlib.log" 2>&1
