#!/bin/bash

if [ -z "$SHARED_DIR" ]; then
    echo "SHARED_DIR envinronment variable must be defined"
    exit 1
fi

cd "$SHARED_DIR"

{
    if [ ! -f 'bashlib.sh' ]; then
        curl -sL https://raw.github.com/jkk-intel/bashlib/main/bashlib.sh > bashlib.sh
        chmod +x bashlib.sh
    fi
} >>"$INSTALL_DIR/bashlib_prep.log" 2>&1

{
    
    if [ ! -d "cicd" ]; then
        git clone https://github.com/jkk-intel/vulcan.git cicd
    fi
    
    (
        cd cicd
        git fetch origin
        git reset --hard origin/main
        git pull
    )

} >>"$INSTALL_DIR/workflowlib.log" 2>&1

if [ -n "$GITHUB_WORKSPACE" ]; then
    shopt -s dotglob
    sudo chown -R "$USER" "$GITHUB_WORKSPACE/"*
    sudo rm -rf "$GITHUB_WORKSPACE/"*
    echo "cleaned up workspace ($GITHUB_WORKSPACE)"
fi

BASHRC_EXTRA_PATH="/home/builder/.bashrc_extra"
BASHRC_EXTRA_REQUIRED_VERSION=2         # see docker/gha/.bashrc_extra
if [ "$(cat "$BASHRC_EXTRA_PATH" | grep BASHRC_EXTRA_VERSION || true)" \
     != "# BASHRC_EXTRA_VERSION=$BASHRC_EXTRA_REQUIRED_VERSION" ]; then
    cp cicd/docker/gha/.bashrc_extra /home/builder/.bashrc_extra
    if [ -f "$SHARED_DIR/.bashrc_extra_additional" ]; then
        cat "$SHARED_DIR/.bashrc_extra_additional" | tee -a "$BASHRC_EXTRA_PATH" >/dev/null
    fi
fi

bash $SHARED_DIR/cicd/lib/shell/toolchain/github-cli/gh.sh

BUILDER_CLI_PACKAGE="intel-build"
REQUIRED_BUILDER_VERSION='0.0.48'
{
    use_nvm
    if ! [ -x "$(command -v builder)" ] || [ "$(builder --version)" != "$REQUIRED_BUILDER_VERSION" ]; then
        npm i -g $BUILDER_CLI_PACKAGE@$REQUIRED_BUILDER_VERSION
    fi
} >/dev/null 2>&1
echo "BUILDER_VERSION=$REQUIRED_BUILDER_VERSION"
