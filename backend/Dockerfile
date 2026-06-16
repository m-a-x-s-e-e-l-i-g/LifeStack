# LifeStack backend — runs TypeScript directly via tsx (no emit step, fewer footguns).
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm install tsx typescript --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 4000

CMD ["npx", "tsx", "src/index.ts"]
