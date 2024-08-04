#!/bin/bash

export PACKAGE_BIN_NAME='setup_python'

SCRIPT_DIR="$(dirname -- "$( readlink -f -- "$0"; )")"
SCRIPT_FILE="$SCRIPT_DIR/$(basename "$0")"

i=0
while [ "$(basename "$SCRIPT_FILE")" != "$(basename "$0")" ] && [ $i -lt 10 ]; do
    SCRIPT_FILE="$(readlink -f "$SCRIPT_FILE")"
    i="$(expr $i + 1)"
done

PACKAGE_DIR="$(dirname "$SCRIPT_FILE")/.."
PACKAGE_DIR="$(realpath "$PACKAGE_DIR")"
case "$(realpath "$PACKAGE_DIR/package.json" 2>/dev/null)" in
    *"lib/node/package.json" )
        (
            echo "Detected invocation from local git"
            cd "$PACKAGE_DIR"
            npx tsc
        )
        ;;
esac 

if [ ! -f "$PACKAGE_DIR/.builder" ]; then
    echo "ERROR: unable to locate package directory for '$PACKAGE_BIN_NAME'" 1>&2
    exit 1
fi

export NODE_OPTIONS=--max_old_space_size=262144
node --enable-source-maps --max-old-space-size=262144 "$PACKAGE_DIR/entrypoint/setup_python.js" "$@"
