#!/bin/bash

if [[ -f "$INSTALL_DIR/runsvc.sh" ]]; then
    echo "Running GitHub Actions runner in service mode ..."
    cd "$INSTALL_DIR"
    bash runsvc.sh
fi

tail -f /dev/null
