#!/bin/bash

# create runner workspace directory
mkdir -p "$RUNNERS_DATA_DIR/$RUNNER_NAME"

# extra bash profile configs
echo '

# other default variables
BASHLIB_LIB_DEFAULT="jkk-intel/bashlib"

' | sudo -a tee /home/builder/.bashrc_extra >/dev/null
sudo chmod 777 /home/builder/.bashrc_extra

echo "
source /home/builder/.bashrc_extra
" | sudo tee -a /home/builder/.bashrc >/dev/null


echo '#!/bin/bash
cp -r $SHARED_DIR/cicd/lib* .github/lib/
' | sudo tee /bin/load-cicd-lib >/dev/null
sudo chmod +x /bin/load-cicd-lib


SCRIPT_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)
bash "$SCRIPT_DIR/install_runner_additional.sh"


# mark finished
touch "$RUNNERS_DATA_DIR/$RUNNER_NAME/runner_install_finished"

