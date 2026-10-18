FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:css && npm prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0

VOLUME ["/app/data"]
RUN mkdir -p /app/data/sessions && chown -R node:node /app/data
EXPOSE 2096

USER node
CMD ["node", "src/index.js"]
