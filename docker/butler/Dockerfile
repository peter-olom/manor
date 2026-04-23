FROM node:22-bookworm

ARG CODEX_VERSION=0.118.0
ARG BUTLER_INSTALL_MODE=development
ARG TTYD_VERSION=1.7.7

WORKDIR /opt/manor/butler

COPY butler/package.json butler/package-lock.json* ./

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    zsh \
    zsh-autosuggestions \
    zsh-syntax-highlighting \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    arm64) ttyd_arch="aarch64" ;; \
    amd64) ttyd_arch="x86_64" ;; \
    *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" -o /usr/local/bin/ttyd \
  && chmod +x /usr/local/bin/ttyd \
  && mkdir -p /home/butler \
  && git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /home/butler/.oh-my-zsh \
  && mkdir -p /home/butler/.oh-my-zsh/custom \
  && npm install -g "@openai/codex@${CODEX_VERSION}" \
  && npm install

COPY butler/ ./
COPY docker/butler/start.sh /usr/local/bin/start-butler
COPY docker/butler/auth.sh /usr/local/bin/butler-auth
COPY docker/butler/chatgpt-login.mjs /usr/local/bin/butler-chatgpt-login.mjs
COPY docker/butler/terminal-shell.sh /usr/local/bin/start-butler-shell
COPY docker/butler/zshrc /home/butler/.zshrc
COPY docker/butler/zprofile /home/butler/.zprofile

RUN chmod +x /usr/local/bin/start-butler /usr/local/bin/butler-auth /usr/local/bin/butler-chatgpt-login.mjs /usr/local/bin/start-butler-shell \
  && npm run build:web \
  && npm run build:server \
  && if [ "$BUTLER_INSTALL_MODE" = "production" ]; then npm prune --omit=dev; fi

EXPOSE 8080 7682

CMD ["/usr/local/bin/start-butler"]
