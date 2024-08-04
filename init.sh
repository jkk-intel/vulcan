#!/bin/bash

if [ -z "$SHARED_DIR" ]; then
    echo "SHARED_DIR envinronment variable must be defined"
    exit 1
fi

cd "$SHARED_DIR"

if [ -n "$GITHUB_WORKSPACE" ]; then
    shopt -s dotglob
    sudo chown -R "$USER" "$GITHUB_WORKSPACE/"* || :
    sudo rm -rf "$GITHUB_WORKSPACE/"* || :
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

BUILDER_CLI_PACKAGE="intel-build"
REQUIRED_BUILDER_VERSION='0.0.64'
{
    export NVM_DIR="$SHARED_DIR/.nvm" ; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh";
    if ! [ -x "$(command -v builder)" ] || [ "$(builder --version)" != "$REQUIRED_BUILDER_VERSION" ]; then
        nvm install 18
        npm i -g $BUILDER_CLI_PACKAGE@$REQUIRED_BUILDER_VERSION
    fi
} >/dev/null 2>&1
echo "BUILDER_VERSION=$REQUIRED_BUILDER_VERSION"

# Remove user's global git auth header that could collide with actions/checkout
git config --global --unset 'http.https://github.com/.extraheader' || true
