# Imagem do servidor Echo para hospedagem (API, gateway e a interface web).
# O banco fica em /data: monte ali um volume persistente, senão as contas e as
# conversas somem a cada reinício.

FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY web ./web

ENV ECHO_HOST=0.0.0.0 \
    ECHO_PORT=8080 \
    ECHO_DATA_DIR=/data \
    ECHO_SECURE_COOKIES=1 \
    ECHO_TRUST_PROXY=1

EXPOSE 8080
CMD ["node", "server/src/index.js"]
