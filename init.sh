#!/bin/bash

if [[ -z "$SHARED_DIR" ]]; then
    echo "SHARED_DIR envinronment variable must be defined"
    exit 1
fi

cd "$SHARED_DIR"

{
    if [[ ! -f 'bashlib.sh' ]]; then
        curl -sL https://raw.github.com/jkk-intel/bashlib/main/bashlib.sh > bashlib.sh
        chmod +x bashlib.sh
    fi
} >>"$INSTALL_DIR/bashlib_prep.log" 2>&1

{
    
    if [[ ! -d "cicd" ]]; then
        git clone https://github.com/jkk-intel/vulcan.git cicd
    fi
    
    cd cicd
    {
        git fetch origin
        git reset --hard origin/main
        git pull
    }
    cd ..

} >>"$INSTALL_DIR/workflowlib.log" 2>&1

if [[ -n "$GITHUB_WORKSPACE" ]]; then
    shopt -s dotglob
    sudo chown -R "$USER" "$GITHUB_WORKSPACE/"*
    sudo rm -rf "$GITHUB_WORKSPACE/"*
    echo "cleaned up workspace ($GITHUB_WORKSPACE)"
fi

if ! grep -q '# vulcan tools' "/home/builder/.bashrc"; then
{
echo '

# vulcan tools
alias setup_node='"'"' bash $SHARED_DIR/cicd/lib/shell/toolchain/venv/node.sh '"'"'
alias setup_python='"'"' bash $SHARED_DIR/cicd/lib/shell/toolchain/venv/python.sh '"'"'

' | tee -a /home/builder/.bashrc_extra >/dev/null || true
} >/dev/null 2>&1
fi

bash $SHARED_DIR/cicd/lib/shell/toolchain/github-cli/gh.sh

REQUIRED_BUILDER_VERSION='0.0.30'
{
    setup_node --use && use_nvm
    if [ ! command -v builder ] || \
       [ "$(builder --version)" != "$REQUIRED_BUILDER_VERSION" ]; then
        npm i -g intel-build@$REQUIRED_BUILDER_VERSION
    fi
} >/dev/null 2>&1
echo "BUILDER_VERSION=$REQUIRED_BUILDER_VERSION"
