# Imagem do servidor Echo (API, gateway e a interface web).
#
# Na Vercel, este arquivo na raiz faz o projeto rodar como contêiner. Lá não há
# disco permanente: adicione um Postgres ao projeto (ele define DATABASE_URL).
#
# Em outra hospedagem, sem Postgres, o banco é um arquivo SQLite em /data:
# monte ali um volume persistente, senão as contas e as conversas somem a cada
# reinício.

FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY web ./web

# PORT pode ser trocada pela hospedagem; 80 é o que a Vercel espera por padrão.
ENV ECHO_HOST=0.0.0.0 \
    PORT=80 \
    ECHO_DATA_DIR=/data \
    ECHO_SECURE_COOKIES=1 \
    ECHO_TRUST_PROXY=1

EXPOSE 80
CMD ["node", "server/src/index.js"]
