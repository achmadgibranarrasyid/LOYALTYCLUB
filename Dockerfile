FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY backend ./backend
COPY public ./public
COPY scripts ./scripts

EXPOSE 8000
VOLUME ["/app/data"]

CMD ["npm", "start"]
