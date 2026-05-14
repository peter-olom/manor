ARG NODE_BUILD_IMAGE=node:24-trixie
ARG NODE_RUNTIME_IMAGE=node:24-trixie-slim

FROM ${NODE_BUILD_IMAGE} AS deps

WORKDIR /opt/manor/runtime-broker

RUN npm init -y \
  && npm install --omit=dev --no-audit --no-fund express dockerode \
  && npm cache clean --force

FROM ${NODE_RUNTIME_IMAGE}

ENV NODE_ENV=production

WORKDIR /opt/manor/runtime-broker

COPY --from=deps /opt/manor/runtime-broker/package.json /opt/manor/runtime-broker/package-lock.json ./
COPY --from=deps /opt/manor/runtime-broker/node_modules ./node_modules
COPY docker/runtime-broker/broker.mjs /opt/manor/runtime-broker/broker.mjs
COPY docker/runtime-broker/broker-browser.mjs /opt/manor/runtime-broker/broker-browser.mjs
COPY docker/runtime-broker/broker-core.mjs /opt/manor/runtime-broker/broker-core.mjs
COPY docker/runtime-broker/broker-desktop.mjs /opt/manor/runtime-broker/broker-desktop.mjs
COPY docker/runtime-broker/broker-runtime.mjs /opt/manor/runtime-broker/broker-runtime.mjs
COPY docker/runtime-broker/broker-services.mjs /opt/manor/runtime-broker/broker-services.mjs
COPY docker/runtime-broker/broker-storage.mjs /opt/manor/runtime-broker/broker-storage.mjs

CMD ["node", "/opt/manor/runtime-broker/broker.mjs"]
