ARG NODE_RUNTIME_IMAGE=node:24-alpine3.23

FROM ${NODE_RUNTIME_IMAGE}

RUN apk add --no-cache squid

COPY docker/egress/squid.conf /etc/squid/squid.conf
COPY docker/egress/built-in-domains.txt /etc/squid/built-in-domains.txt
COPY docker/egress/server.mjs /opt/manor/egress/server.mjs
COPY docker/egress/start.sh /usr/local/bin/start-egress

RUN chmod 0755 /usr/local/bin/start-egress

CMD ["/usr/local/bin/start-egress"]
