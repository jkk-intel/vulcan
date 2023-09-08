#/bin/bash
set -e
source "$SHARED_DIR/bashlib.sh"

argp param -v --version PYTHON_VERSION "default:3.11"
argp param -r --requirements-file REQUIREMENTS_FILE "default:requirements.txt"
argp param -p --venv-inventory-path VENV_INVENTORY_PATH "default:$SHARED_DIR/.python_venvs"
argp param -c --pip-cache-path PIP_CACHE_PATH
argp param -e --evict-older-than EVICT_OLDER_THAN