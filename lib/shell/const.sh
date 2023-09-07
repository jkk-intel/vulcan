#!/bin/bash

# Provide ATHENA_ROOT if it's not provided by environment
ATHENA_ROOT="${ATHENA_ROOT:=.}"

# Default source for bashlib packages which hosts bash utilities
# that has nothing to do with pipeline or athena flow
BASHLIB_LIB_DEFAULT="jkk-intel/bashlib"

# Git repo constants
CONST_GITHUB_BASE="https://github.com"
CONST_TPE_GIT="applications.security.trusted-platform"
CONST_TPE_ATHENA="core.athena"
CONST_TPE_BFT="core.concord-bft"
CONST_TPE_HERMES="test.hermes"
CONST_TPE_DDMBT="test.ddmbt"
CONST_INNERSOURCE="intel-innersource"
CONST_SANDBOX="intel-sandbox"

CONST_SUBMODULE_BFT_PATH="concord/submodules/concord-bft"
CONST_SUBMODULE_HERMES_PATH="hermes"
CONST_SUBMODULE_DDBMT_PATH="hermes/submodules/ddmbt"

CONST_BUILD_CMD=".github/lib/shell/docker_buildx_build.sh"

# Docker cache
CONST_LOCAL_CACHE_SERVER="docker-cache.tpe.amr.corp.intel.com"
CONST_DEFAULT_CACHE_REGISTRY_DOMAIN="docker-cache.tpe.amr.corp.intel.com"
CONST_DEFAULT_CACHE_REGISTRY="$CONST_DEFAULT_CACHE_REGISTRY_DOMAIN/tpe-temp/docker-build-cache"
CONST_CACHE_TO_AUTH_REQUIRED=""
# image-manifest=true is required only by Harbor
CONST_CACHE_COMPRESS="compression=zstd,compression-level=9"
CONST_CACHE_TO_CONFIG="mode=max,ignore-error=true,$CONST_CACHE_COMPRESS,image-manifest=true"

# BuildKit builder image with Intel CA root certs and Harbor certs already baked in the config
CONST_BUILDER_IMAGE="amr-registry.caas.intel.com/tpe-dev/devsecops/builder:initial"

# Docker build args
CONST_DOCKER_HTTP_PROXY="http://proxy-chain.intel.com:911"
CONST_DOCKER_HTTPS_PROXY="http://proxy-chain.intel.com:911"
CONST_DOCKER_NO_PROXY="localhost,192.168.0.0/16,127.0.0.0/8,::1,intel.com"
CONST_DOCKER_PROXY_ARGS="\
--build-arg HTTP_PROXY=$CONST_DOCKER_HTTP_PROXY \
--build-arg HTTPS_PROXY=$CONST_DOCKER_HTTPS_PROXY \
--build-arg NO_PROXY=$CONST_DOCKER_NO_PROXY \
"

# Runtime log paths
CONST_BUILDX_DIR=".github/runtime/buildx"
CONST_GIT_INFO_DIR=".github/runtime/git"

# Bash colors for errors and warning
ERRORC='\033[0;31m' # red
WARNC='\033[0;33m'  # yellow
DEBUGC='\033[0;30m' # gray
NC='\033[0m'        # no color

# TODO; we need to fetch this dynamically from microservice
CONST_REMOTE_BUILD_WORKERS=(
    "vra, quick-lease, 1999, builder-1.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-2.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-3.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-4.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-5.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-6.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-8.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-9.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-11.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-12.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-13.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-14.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-15.tpe.amr.corp.intel.com, 2000"
    "vra, quick-lease, 1999, builder-16.tpe.amr.corp.intel.com, 2000"
)

function exec() {
    # USAGE: exec [command arguments ...]
    # conditionally redirects output to file
    if [ -n "$EXEC_OUTPUT_TO" ]; then "$@" >> "$EXEC_OUTPUT_TO" 2>&1; else "$@"; fi
}
function warn() {
    # USAGE: warn [arguments ...]
    exec echo -e "${WARNC}$@${NC}"
}
function info() {
    # USAGE: exec [context arguments ...]
    local NAME="$1"; shift
    if [[ -n "$1" ]]; then
        exec echo -e "$NAME:${WARNC} $@ ${NC}"
    fi
}
function debug() {
    # USAGE: exec [context arguments ...]
    local NAME="$1"; shift
    if [[ -n "$1" ]]; then
        exec echo -e "${DEBUGC}$NAME: $@ ${NC}"
    fi
}
function proxy_env_init() {
    # USAGE: eval "$(proxy_env_init)"
    echo "export HTTP_PROXY=$CONST_DOCKER_HTTP_PROXY ;" \
         "export HTTPS_PROXY=$CONST_DOCKER_HTTPS_PROXY ;" \
         "export NO_PROXY=$CONST_DOCKER_NO_PROXY ;"
}
