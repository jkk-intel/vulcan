#!/bin/bash

# create runner workspace directory
mkdir -p "$RUNNERS_DATA_DIR/$RUNNER_NAME"

# extra bash profile configs
echo '
# import guard
if [[ -n "$BASHRC_EXTRA_IMPORTED" ]]; then return; fi
BASHRC_EXTRA_IMPORTED=1

# alias options
shopt -s expand_aliases
alias __dir='"'"'cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd'"'"'
alias __tools='"'"'printf "$SHARED_DIR"'"'"'
alias use_nvm='"'"'export NVM_DIR="$SHARED_DIR/.nvm" ; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" '"'"'
alias use_pyenv='"'"'export PYENV_ROOT="$SHARED_DIR/.pyenv" ; command -v pyenv >/dev/null || export PATH="$PYENV_ROOT/bin:$PATH" '"'"'

# other default variables
BASHLIB_LIB_DEFAULT="jkk-intel/bashlib"

' | sudo tee /home/builder/.bashrc_extra >/dev/null
sudo chmod 777 /home/builder/.bashrc_extra


echo "
source /home/builder/.bashrc_extra
" | sudo tee -a /home/builder/.bashrc >/dev/null


echo '#!/bin/bash
cp -r $SHARED_DIR/cicd/lib* .github/lib/
' | sudo tee /bin/load-cicd-lib >/dev/null
sudo chmod +x /bin/load-cicd-lib


SCRIPT_DIR="cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd"
bash "$SCRIPT_DIR/install_runner_additional.sh"


# mark finished
touch "$RUNNERS_DATA_DIR/$RUNNER_NAME/runner_install_finished"

