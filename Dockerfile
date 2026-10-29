FROM node:24.21.0-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.4.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

EXPOSE 4179
CMD ["node", "script/product.js"]
