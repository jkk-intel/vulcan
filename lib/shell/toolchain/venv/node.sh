#/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

NVM_VERSION="0.39.3"

function prepare_nvm() {
    use_nvm
    if [[ -z "$(command -v nvm)" ]]; then
        (
            HOME="$SHARED_DIR" \
            mkdir -p "$NVM_DIR"
            wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v$NVM_VERSION/install.sh | bash
        )
    fi
    use_nvm
}

function get_node_lts_version() {
    local NODE_LATEST_LTS_INFO_FILE="$SHARED_DIR/node_lts_info"
    if [[ -f "$NODE_LATEST_LTS_INFO_FILE" ]]; then
        local CACHE_STALE_TIME=259200 # 3 days
        local LTS_INFO="$(cat "$NODE_LATEST_LTS_INFO_FILE")"
        local LTS_INFO_SPLIT=
        str_split "$LTS_INFO" --delim '|' --into LTS_INFO_SPLIT
        local FETCHED_LTS="${LTS_INFO_SPLIT[0]}"
        local FETCHED_LAST="${LTS_INFO_SPLIT[1]}"
        local NOW=$(date +%s)
        if [[ "$(( $NOW - $FETCHED_LAST ))" -lt "$CACHE_STALE_TIME" ]]; then
            echo "$FETCHED_LTS";
            return
        fi
    fi
    local NODE_LATEST_LTS=
    {
        prepare_nvm
        NODE_LATEST_LTS="$(nvm ls-remote | grep 'Latest LTS' | tail -n1 | awk '$1=$1' | cut -f1 -d' ' | sed 's|v||g')"
        echo "$NODE_LATEST_LTS|$(date +%s)" > "$NODE_LATEST_LTS_INFO_FILE"
    } >/dev/null 2>&1
    echo "$NODE_LATEST_LTS"
}

NODE_LTS_VERSION="$(get_node_lts_version)"

import argp
argp param -v --version NODE_VERSION "default:$NODE_LTS_VERSION"
argp param -f --package-json-file PACKAGE_JSON_FILE "default:package.json"
argp param -p --venv-inventory-path VENV_INVENTORY_PATH "default:$SHARED_DIR/node_venvs"
argp param -c --npm-cache-path NPM_CACHE_PATH
argp param -e --evict-older-than EVICT_OLDER_THAN
eval "$(argp parse "$@")"

if [[ -z "$PACKAGE_JSON_FILE" ]]; then
    error "param --package-json-file must be provided"
fi

if [[ -z "$NPM_CACHE_PATH" ]]; then
    NPM_CACHE_PATH="$VENV_INVENTORY_PATH/npm-cache"
fi

# get unique shasum of package.json
PKG_JSON_FILE_SHASUM="$(shasum -a 256 "$PACKAGE_JSON_FILE" | cut -d' ' -f1)"
PKG_JSON_FILE_SHASUM="${PKG_JSON_FILE_SHASUM:0:24}"  # 24-byte hex; truncate rest
VENV_FOLDER="$VENV_INVENTORY_PATH/$PKG_JSON_FILE_SHASUM"

if [[ -d "$VENV_FOLDER" ]] && [[ -f "$VENV_FOLDER/last_used" ]]; then
    # detected the same venv existing, just use that
    date +%s > "$VENV_FOLDER/last_used"
    echo "$VENV_FOLDER"
    exit 0
fi


# prepare node base
{
    prepare_nvm
    nvm install "$NODE_LTS_VERSION"
    rm -rf "$VENV_FOLDER"
    mkdir -p "$VENV_FOLDER"
    cp $PACKAGE_JSON_FILE "$VENV_FOLDER/"
} 1>&2 # redirect all stdout to stderr

# install venv at location
{
    # prepare cache-dir and tmp-dir used for installation
    export NPM_CONFIG_CACHE="$NPM_CACHE_PATH"
    export TMPDIR="$VENV_INVENTORY_PATH/tmp"
    mkdir -p "$NPM_CACHE_PATH" "$TMPDIR"
    
    cd "$VENV_FOLDER"
    export NPM_CONFIG_PREFIX="$VENV_FOLDER"
    echo "NPM_CONFIG_PREFIX=$NPM_CONFIG_PREFIX"
    echo "Installing packages with node $(node -v) (npm v$(npm -v))"
    echo "Contents of $PACKAGE_JSON_FILE:"
    cat "$PACKAGE_JSON_FILE"
    npm i --include=dev

} 1>&2 # redirect all stdout to stderr

# echo the prepare venv path and mark last used
echo "$VENV_FOLDER"
date +%s > "$VENV_FOLDER/last_used"
