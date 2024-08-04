#!/bin/bash

# clean up workspace for github actions env
if [ -n "$GITHUB_WORKSPACE" ]; then
    shopt -s dotglob
    sudo chown -R "$USER" "$GITHUB_WORKSPACE/"* || :
    sudo rm -rf "$GITHUB_WORKSPACE/"* || :
    echo "cleaned up workspace ($GITHUB_WORKSPACE)"
fi

# Remove user's global git auth header that could collide with actions/checkout
git config --global --unset 'http.https://github.com/.extraheader' || true

# update builder tool
bash /home/builder/builder_update.sh
