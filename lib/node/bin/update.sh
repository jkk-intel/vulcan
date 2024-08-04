#!/bin/bash

shopt -s expand_aliases

# ==============================================================================
# ensure package directory is resolved
export PACKAGE_BIN_NAME='builder-update'

SCRIPT_DIR="$(dirname -- "$( readlink -f -- "$0"; )")"
SCRIPT_FILE="$SCRIPT_DIR/$(basename "$0")"
i=0
while [ "$(basename "$SCRIPT_FILE")" != "$(basename "$0")" ] && [ $i -lt 10 ]; do
    SCRIPT_FILE="$(readlink -f "$SCRIPT_FILE")"
    i="$(expr $i + 1)"
done

PACKAGE_DIR="$(dirname "$SCRIPT_FILE")/.."
PACKAGE_DIR="$(realpath "$PACKAGE_DIR")"
if [ ! -f "$PACKAGE_DIR/.builder" ]; then
    echo "ERROR: unable to locate package directory for '$PACKAGE_BIN_NAME'" 1>&2
    exit 1
fi
# ==============================================================================

NODE_VER='18'

# ensure nvm
if [ -z "$(nvm -v 2>/dev/null ||:)" ]; then
    . "$NVM_DIR/nvm.sh"
fi
case "$(which node)" in
    *".nvm/versions/node/v$NODE_VER"* )
        # correct NODE_VER already activated
        ;;
    *)
        nvm install "$NODE_VER" noout ||:
        nvm alias default "$NODE_VER" noout ||:
esac

# ensure builder package globally installed as latest
PACKAGE_NAME="$(cat package.json | jq -r '.name')"
LATEST_VERSION="$(npm view "$PACKAGE_NAME" version)"
case "$(npm -g list "$PACKAGE_NAME")" in
    *"@$LATEST_VERSION"* )
        # builder package already installed
        ;;
    *)
        npm i -g "$PACKAGE_NAME@$LATEST_VERSION" >/dev/null 2>&1 ||:
esac
