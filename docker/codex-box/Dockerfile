FROM node:22-bookworm

ARG CODEX_VERSION=0.118.0
ARG MISE_VERSION=2026.4.3
ARG TTYD_VERSION=1.7.7

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bubblewrap \
      build-essential \
      ca-certificates \
      curl \
      fd-find \
      git \
      gh \
      jq \
      python-is-python3 \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      unzip \
      xz-utils \
      zsh \
      zsh-autosuggestions \
      zsh-syntax-highlighting \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
      arm64) ttyd_arch="aarch64" ;; \
      amd64) ttyd_arch="x86_64" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && npm install -g "@jdxcode/mise@${MISE_VERSION}" \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && useradd --create-home --shell /bin/bash codex \
    && mkdir -p /state /repos /artifacts /home/codex/.codex /opt/manor/codex-box \
    && git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /home/codex/.oh-my-zsh \
    && mkdir -p /home/codex/.oh-my-zsh/custom \
    && chown -R codex:codex /state /repos /artifacts /home/codex /opt/manor

COPY docker/codex-box/start.sh /usr/local/bin/start-codex-app-server
COPY docker/codex-box/auth.sh /usr/local/bin/codex-auth
COPY docker/codex-box/gh-auth-headless.sh /usr/local/bin/gh-auth-headless
COPY docker/codex-box/gh-headless-browser.sh /usr/local/bin/gh-headless-browser
COPY docker/codex-box/bootstrap-tools.sh /usr/local/bin/codex-bootstrap-tools
COPY docker/codex-box/healthcheck.mjs /opt/manor/codex-box/healthcheck.mjs
COPY docker/codex-box/zshrc /home/codex/.zshrc
COPY docker/codex-box/zprofile /home/codex/.zprofile

ENV PATH="/home/codex/.local/bin:/home/codex/.local/share/mise/shims:/home/codex/.local/share/mise/bin:${PATH}"

RUN chmod +x /usr/local/bin/start-codex-app-server /usr/local/bin/codex-auth /usr/local/bin/gh-auth-headless /usr/local/bin/gh-headless-browser /usr/local/bin/codex-bootstrap-tools \
    && chown codex:codex /home/codex/.zshrc /home/codex/.zprofile

USER codex
WORKDIR /repos

CMD ["/usr/local/bin/start-codex-app-server"]
