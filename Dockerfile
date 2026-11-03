FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
ENV HOST=0.0.0.0 PORT=3000 YYC_DATA_DIR=/app/data
USER node
EXPOSE 3000
CMD ["node","src/server.js"]
