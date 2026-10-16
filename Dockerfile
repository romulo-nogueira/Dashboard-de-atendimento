FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server server
COPY js js
COPY css css
COPY data data
COPY index.html robots.txt ./
RUN mkdir -p /data && chown -R node:node /data /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/opa.db
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
