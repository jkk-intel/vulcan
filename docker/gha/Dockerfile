FROM ubuntu:22.04

ARG GIT_CORE_PPA_KEY="A1715D88E1DF1F24"
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV DEBIAN_FRONTEND=noninteractive
  
RUN echo en_US.UTF-8 UTF-8 >> /etc/locale.gen && \
    apt-get update && apt-get install -y \
      sudo gnupg gpg-agent locales lsb-release \
      curl tar unzip zip zstd jq wget vim nano gosu git \
      apt-transport-https ca-certificates openssh-client \
      software-properties-common build-essential \
      parallel rsync gettext dirmngr inetutils-ping \
      expect dnsutils netcat dumb-init

RUN apt-get install -y \
    golang-go \
    nodejs \
    python3 python3-pip python3-dev python3-setuptools python3-openssl \
        libsqlite3-dev libbz2-dev libreadline-dev libssl-dev libffi-dev \
        zlib1g-dev liblzma-dev libncurses5 libncurses5-dev libncursesw5 \
        libkrb5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev \
    libcurl4-openssl-dev libpq-dev \
    dumb-init

RUN useradd -m builder && \
    passwd --delete builder && \
    adduser builder sudo && \
    echo '%sudo ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers && \
    wget https://raw.githubusercontent.com/gdraheim/docker-systemctl-replacement/master/files/docker/systemctl3.py -O /usr/bin/systemctl

USER builder

WORKDIR /
COPY pre_workflow_script.sh \
     post_workflow_script.sh \
        ./

WORKDIR /home/builder
COPY .bashrc_extra \
    install_runner.sh \
    install_runner_additional.sh \
    builder_update.sh \
    entrypoint.sh \
        ./
        
RUN sudo chmod +x ./entrypoint.sh

ENTRYPOINT /home/builder/entrypoint.sh
