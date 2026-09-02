FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src/ ./src/
COPY bin/ ./bin/

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8788

ENV LIBREPIXEL_ORIGIN=""
ENV LIBREPIXEL_TRUST_PROXY=""

CMD ["node", "bin/librepixel.ts", "serve", "--dir", "/data", "--host", "0.0.0.0"]
