#!/bin/bash

if [ -z "$(nvm -v 2>/dev/null ||:)" ]; then
    . "$NVM_DIR/nvm.sh"
fi

# ensure nvm
NODE_VER='18'
case "$(which node)" in
    *".nvm/versions/node/v$NODE_VER"* )
        # correct NODE_VER already activated
        ;;
    *)
        nvm install "$NODE_VER" >/dev/null 2>&1 ||:
        nvm alias default "$NODE_VER" >/dev/null 2>&1 ||:
esac

PACAKGE_NAME='intel-build'
LATEST_VERSION="$(npm view "$PACAKGE_NAME" version)"
INSTALLED_OUTPUT="$(npm -g list "$PACAKGE_NAME")"

# ensure builder package globally installed
case "$INSTALLED_OUTPUT" in
    *"@$LATEST_VERSION"* )
        # builder package already installed
        ;;
    *)
        npm i -g "$PACAKGE_NAME@$LATEST_VERSION" >/dev/null 2>&1 ||:
esac
