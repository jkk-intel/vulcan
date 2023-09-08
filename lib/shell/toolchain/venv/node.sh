#/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

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
        use_nvm
        NODE_LATEST_LTS="$(nvm ls-remote | grep 'Latest LTS' | tail -n1 | awk '$1=$1' | cut -f1 -d' ' | sed 's|v||g')"
        echo "$NODE_LATEST_LTS|$(date +%s)" > "$NODE_LATEST_LTS_INFO_FILE"
    } >/dev/null 2>&1
    echo "$NODE_LATEST_LTS"
}

function get_node_lts_version() {
    local NODE_LATEST_LTS_INFO_FILE="$SHARED_DIR/node_lts_info"
    local NEED_TO_FETCH=
    if [[ -f "$NODE_LATEST_LTS_INFO_FILE" ]]; then
        NOW=$(date +%s)
        $(( NOW - ))
        {
            NODE_LATEST_LTS="$(nvm ls-remote | grep 'Latest LTS' | tail -n1 | awk '$1=$1' | cut -f1 -d' ' | sed 's|v||g')"
        } >/dev/null 2>&1
    else
        NEED_TO_FETCH=true
    fi
    NODE_LATEST_LTS="$(nvm ls-remote | grep 'Latest LTS' | tail -n1 | awk '$1=$1' | cut -f1 -d' ' | sed 's|v||g')"
}

argp param -v --version NODE_VERSION "default:$NODE_LATEST_LTS"
argp param -f --package-json-file PACKAGE_JSON_FILE "default:package.json"
argp param -p --venv-inventory-path VENV_INVENTORY_PATH "default:$SHARED_DIR/node_venvs"
argp param -c --npm-cache-path NPM_CACHE_PATH
argp param -e --evict-older-than EVICT_OLDER_THAN

if [[ -z "$REQUIREMENTS_FILE" ]]; then
    echo -e "${ERRORC}param --requirements-file must be provided ${NC}" 1>&2
    exit 1
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
