#!/bin/bash

SCRIPT_DIR="$(dirname -- "$( readlink -f -- "$0"; )")"
cd "$SCRIPT_DIR"

find . -name "*.js.map" -type f -not -path "./node_modules/*" -delete
find . -name "*.js" -type f -not -path "./node_modules/*" -delete
