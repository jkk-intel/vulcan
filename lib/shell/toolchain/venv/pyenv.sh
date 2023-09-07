#/bin/bash
set -e
source "$(__dir)/../bashlib.sh"

import argp
argp param -v --python-version PYTHON_VERSION "default:3.11"
argp param -r --requirements-file REQUIREMENTS_FILE "default:hermes/requirements.txt"
argp param -p --venv-inventory-path VENV_INVENTORY_PATH "default:$HOME/.python_venvs"
argp param -c --pip-cache-path PIP_CACHE_PATH
argp param -e --evict-older-than EVICT_OLDER_THAN
eval "$(argp parse "$@")"

if [[ -z "$REQUIREMENTS_FILE" ]]; then
    echo -e "${ERRORC}param --requirements-file must be provided ${NC}" 1>&2
    exit 1
fi

if [[ -n $(mkdir -p "$VENV_INVENTORY_PATH" || echo "CANNOT_INITIALIZE_VENV_FOLDER") ]]; then
    echo -e "${ERRORC} unable to prepare shared venv inventory folder at $VENV_INVENTORY_PATH ${NC}" 1>&2
    exit 1
fi

if [[ -z "$PIP_CACHE_PATH" ]]; then
    PIP_CACHE_PATH="$VENV_INVENTORY_PATH/pip-cache"
fi 

# get unique shasum of requirements.txt
REQUIREMENTS_FILE_SHASUM="$(shasum -a 256 "$REQUIREMENTS_FILE" | cut -d' ' -f1)"
REQUIREMENTS_FILE_SHASUM="${REQUIREMENTS_FILE_SHASUM:0:24}"  # 24-byte hex; truncate rest
VENV_FOLDER="$VENV_INVENTORY_PATH/$REQUIREMENTS_FILE_SHASUM"

if [[ -d "$VENV_FOLDER" ]] && [[ -f "$VENV_FOLDER/last_used" ]]; then
    # detected the same venv existing, just use that
    date +%s > "$VENV_FOLDER/last_used"
    echo "$VENV_FOLDER"
    exit 0
fi

# prepare python
{
    pyenv install --skip-existing "$PYTHON_VERSION"
}

# install venv at location
{
    # prepare cache-dir and tmp-dir used for installation
    export PIP_CACHE_DIR="$PIP_CACHE_PATH"
    export TMPDIR="$VENV_INVENTORY_PATH/tmp"
    mkdir -p "$PIP_CACHE_DIR" "$TMPDIR"
    
    # create fresh venv and make it available by sourcing it
    rm -rf "$VENV_FOLDER"
    python3 -m venv "$VENV_FOLDER"
    source "$VENV_FOLDER/bin/activate"
    
    # get up-to-date wheel & bdist
    pip install wheel && \
        python setup.py install && \
        python setup.py bdist_wheel
    
    # resolve packages
    pip install -r "$REQUIREMENTS_FILE"

} 1>&2 # redirect all stdout to stderr

# echo the prepare venv path and mark last used
echo "$VENV_FOLDER"
date +%s > "$VENV_FOLDER/last_used"
