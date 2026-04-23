FROM node:22-bookworm-slim

WORKDIR /opt/manor/runtime-broker

COPY docker/runtime-broker/broker.mjs /opt/manor/runtime-broker/broker.mjs
COPY docker/runtime-broker/broker-browser.mjs /opt/manor/runtime-broker/broker-browser.mjs
COPY docker/runtime-broker/broker-core.mjs /opt/manor/runtime-broker/broker-core.mjs
COPY docker/runtime-broker/broker-runtime.mjs /opt/manor/runtime-broker/broker-runtime.mjs
COPY docker/runtime-broker/broker-services.mjs /opt/manor/runtime-broker/broker-services.mjs
COPY docker/runtime-broker/broker-storage.mjs /opt/manor/runtime-broker/broker-storage.mjs

RUN npm install --omit=dev express dockerode

CMD ["node", "/opt/manor/runtime-broker/broker.mjs"]
