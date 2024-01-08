#!/bin/bash

PACKAGE_BIN_NAME='builder'

command_not_found() { echo "ERROR: '$1' command not found while running '$PACKAGE_BIN_NAME'" >&2; }
realpath2() { realpath "$1" 2>/dev/null; }
if ! command -v dirname >/dev/null 2>&1; then command_not_found dirname && exit 1; fi
if ! command -v basename >/dev/null 2>&1; then command_not_found basename && exit 1; fi
if ! command -v readlink >/dev/null 2>&1; then command_not_found readlink && exit 1; fi
if ! command -v realpath >/dev/null 2>&1; then command_not_found realpath && exit 1; fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_FILE="$SCRIPT_DIR/$(basename "$0")"
while [ "$(basename "$SCRIPT_FILE")" != "main.sh" ]; do
    SCRIPT_FILE="$(readlink -f "$SCRIPT_FILE")"
done

PACKAGE_DIR="$(dirname "$SCRIPT_FILE")"
case "$(realpath2 "$PACKAGE_DIR/package.json")" in
    *"lib/node/package.json" )
        (
            echo "Detected invocation from local git"
            cd "$PACKAGE_DIR"
            npx tsc
        )
        ;;
esac 

if [ ! -f "$PACKAGE_DIR/main.js" ]; then
    echo "ERROR: unable to locate main.js for '$PACKAGE_BIN_NAME'" 1>&2
    exit 1
fi

export NODE_OPTIONS=--max_old_space_size=262144
node --enable-source-maps --max-old-space-size=262144 "$PACKAGE_DIR/main.js" "$@"
