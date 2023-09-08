#/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

import argp
argp param -v --version PYTHON_VERSION "default:3.11"
argp param -f --requirements-file REQUIREMENTS_FILE "default:requirements.txt"
argp param -p --venv-inventory-path VENV_INVENTORY_PATH "default:$SHARED_DIR/python_venvs"
argp param -c --pip-cache-path PIP_CACHE_PATH
argp param -e --evict-older-than EVICT_OLDER_THAN
eval "$(argp parse "$@")"

if [[ -z "$REQUIREMENTS_FILE" ]]; then
    error "param --requirements-file must be provided"
    exit 1
fi

if [[ -n $(mkdir -p "$VENV_INVENTORY_PATH" || echo "CANNOT_INITIALIZE_VENV_FOLDER") ]]; then
    error "unable to prepare shared venv inventory folder at $VENV_INVENTORY_PATH"
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

# prepare python base
$PYTHON_INSTALL_LOCKNAME="pyenv-python-install-$PYTHON_VERSION"
{
    use_pyenv
    rm -rf "$VENV_FOLDER"
    RESULT=$(trylock "$PYTHON_INSTALL_LOCKNAME" 600 "$VENV_FOLDER/last_used")
    if [[ "$RESULT" == 'should_handle' ]]; then
        function install_python() {
            pyenv install --skip-existing "$PYTHON_VERSION"
            pyenv local "$PYTHON_VERSION"
            pyenv exec python -m venv "$VENV_FOLDER"
        }
        FAILED= && install_python || FAILED=true
        unlock "$PYTHON_INSTALL_LOCKNAME"
        if [[ "$FAILED" ]]; then
            error "Python installation has failed with non-zero exit code"
        fi
    fi
} 1>&2 # redirect all stdout to stderr

# install venv at location
{
    # prepare cache-dir and tmp-dir used for installation
    export PIP_CACHE_DIR="$PIP_CACHE_PATH"
    export TMPDIR="$VENV_INVENTORY_PATH/tmp"
    mkdir -p "$PIP_CACHE_DIR" "$TMPDIR"
    
    source "$VENV_FOLDER/bin/activate"
    
    # get up-to-date wheel & bdist
    pip install wheel && \
        python setup.py bdist_wheel && \
        python setup.py install
    
    # resolve packages
    echo "Installing packages with python, $(pyenv version)"
    echo "$(pip -V)"
    echo ""
    echo "Contents of $REQUIREMENTS_FILE:"
    cat "$REQUIREMENTS_FILE"
    echo ""
    echo ""
    pip install -r "$REQUIREMENTS_FILE"

} 1>&2 # redirect all stdout to stderr

# echo the prepare venv path and mark last used
echo "$VENV_FOLDER"
date +%s > "$VENV_FOLDER/last_used"