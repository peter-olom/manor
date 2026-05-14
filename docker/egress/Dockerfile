ARG ALPINE_IMAGE=alpine:3.23

FROM ${ALPINE_IMAGE}

RUN apk add --no-cache squid

COPY docker/egress/squid.conf /etc/squid/squid.conf

CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
