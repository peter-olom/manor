ARG NODE_RUNTIME_IMAGE=node:24-alpine3.23

FROM ${NODE_RUNTIME_IMAGE}

ENV NODE_ENV=production

WORKDIR /opt/manor/preview-egress

COPY docker/preview-egress/server.mjs /opt/manor/preview-egress/server.mjs

CMD ["node", "/opt/manor/preview-egress/server.mjs"]
