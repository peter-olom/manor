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
COPY docker/codex-box/manor-harness.mjs /usr/local/bin/manor-harness
COPY docker/codex-box/install-guard.sh /opt/manor/codex-box/install-guard.sh
COPY docker/codex-box/python-guard.sh /opt/manor/codex-box/python-guard.sh
COPY docker/codex-box/manor-shell-env.sh /etc/profile.d/manor-shell-env.sh
COPY docker/codex-box/healthcheck.mjs /opt/manor/codex-box/healthcheck.mjs
COPY docker/codex-box/zshrc /home/codex/.zshrc
COPY docker/codex-box/zprofile /home/codex/.zprofile

ENV MANOR_REAL_PATH="/home/codex/.local/bin:/home/codex/.local/share/mise/shims:/home/codex/.local/share/mise/bin:${PATH}"
ENV PATH="/opt/manor/codex-box/install-guard-bin:${MANOR_REAL_PATH}"

RUN mkdir -p /opt/manor/codex-box/install-guard-bin \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/npm \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/npx \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/pnpm \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/pnpx \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/yarn \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/yarnpkg \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/bun \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/bunx \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/pip \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/pip3 \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/pipx \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/uv \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/uvx \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/poetry \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/gem \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/bundle \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/composer \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/cargo \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/go \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/corepack \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/playwright \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/apt \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/apt-get \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/apk \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/dnf \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/yum \
    && ln -sf /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/install-guard-bin/brew \
    && ln -sf /opt/manor/codex-box/python-guard.sh /opt/manor/codex-box/install-guard-bin/python \
    && ln -sf /opt/manor/codex-box/python-guard.sh /opt/manor/codex-box/install-guard-bin/python3 \
    && chmod +x /usr/local/bin/start-codex-app-server /usr/local/bin/codex-auth /usr/local/bin/gh-auth-headless /usr/local/bin/gh-headless-browser /usr/local/bin/codex-bootstrap-tools /usr/local/bin/manor-harness /opt/manor/codex-box/install-guard.sh /opt/manor/codex-box/python-guard.sh /etc/profile.d/manor-shell-env.sh \
    && chown codex:codex /home/codex/.zshrc /home/codex/.zprofile

USER codex
WORKDIR /repos

CMD ["/usr/local/bin/start-codex-app-server"]
