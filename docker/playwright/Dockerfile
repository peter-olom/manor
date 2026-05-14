ARG NODE_BUILD_IMAGE=node:24-trixie-slim
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.60.0-noble
ARG PLAYWRIGHT_VERSION=1.60.0

FROM ${NODE_BUILD_IMAGE} AS deps

ARG PLAYWRIGHT_VERSION

WORKDIR /opt/manor/playwright

RUN npm init -y \
  && npm install --omit=dev --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
  && npm cache clean --force

FROM ${PLAYWRIGHT_IMAGE}

ENV NODE_ENV=production

WORKDIR /opt/manor/playwright

COPY --from=deps /opt/manor/playwright/package.json /opt/manor/playwright/package-lock.json ./
COPY --from=deps /opt/manor/playwright/node_modules ./node_modules
COPY docker/playwright/browser-use-server.mjs /opt/manor/playwright/browser-use-server.mjs
COPY docker/playwright/start-browser-use.sh /usr/local/bin/start-browser-use

RUN chmod +x /usr/local/bin/start-browser-use \
  && rm -rf /tmp/* /var/tmp/*

CMD ["/usr/local/bin/start-browser-use"]
