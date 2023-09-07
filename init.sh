#!/bin/bash
SCRIPT_DIR="$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)"


if [[ -z "$SHARED_DIR" ]]; then
    echo "SHARED_DIR envinronment variable must be defined"
    exit 1
fi

cd "$SHARED_DIR"

{
    rm -rf $GITHUB_WORKSPACE/*
    
    if [[ ! -d "cicd" ]]; then
        git clone https://github.com/jkk-intel/vulcan.git cicd
    fi
    cd cicd
    
    git fetch origin
    git reset --hard origin/main
    git pull

} >>"$INSTALL_DIR/workflowlib.log" 2>&1

echo '#!/bin/bash
set -e
' | sudo tee /bin/docker-build >/dev/null
sudo chmod +x /bin/docker-build

