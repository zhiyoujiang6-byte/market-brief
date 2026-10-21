FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# This app has no third-party runtime dependencies. Copy only the files that
# are needed at runtime; private/ (including MCP credentials) is intentionally
# excluded from the image.
COPY --chown=node:node package.json server.js README.md ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

USER node

EXPOSE 4173

CMD ["npm", "start"]
