# Node 22 is what Amazon Linux 2023 ships and what package.json engines allows,
# so the lockfile resolves the same way on a laptop and on the server.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

# Dependencies first, so a change to the app does not reinstall them.
# --frozen-lockfile fails loudly rather than quietly resolving something else.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY . .

# The image runs as an unprivileged user; the node image already provides one.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
