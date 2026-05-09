FROM oven/bun:1.3.3-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
CMD ["bun", "run", "start"]
