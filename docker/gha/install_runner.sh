#!/bin/bash

# create runner workspace directory
mkdir -p "$RUNNERS_DATA_DIR/$RUNNER_NAME"

# extra bash profile configs
echo '

# add custom default bash profile here

' | sudo tee -a /home/builder/.bashrc_extra >/dev/null
sudo chmod 777 /home/builder/.bashrc_extra

echo "
. /home/builder/.bashrc_extra
" | sudo tee -a /home/builder/.bashrc >/dev/null

SCRIPT_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)
bash "$SCRIPT_DIR/install_runner_additional.sh"

# mark finished
touch "$RUNNERS_DATA_DIR/$RUNNER_NAME/runner_install_finished"

