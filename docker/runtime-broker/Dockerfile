FROM node:22-bookworm-slim

WORKDIR /opt/manor/runtime-broker

COPY docker/runtime-broker/broker.mjs /opt/manor/runtime-broker/broker.mjs

RUN npm install --omit=dev express dockerode

CMD ["node", "/opt/manor/runtime-broker/broker.mjs"]
