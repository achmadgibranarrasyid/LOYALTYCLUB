FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node backend ./backend
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node *.html *.js *.css ./
COPY --chown=node:node mont-logo.svg ./

RUN mkdir -p /app/data /backups && chown -R node:node /app/data /backups

USER node
EXPOSE 8000
VOLUME ["/app/data"]

CMD ["node", "backend/server.js"]
