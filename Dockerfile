FROM python:3.13-slim

ENV NODE_ENV=production
WORKDIR /app

COPY requirements.txt ./
COPY backend ./backend
COPY scripts ./scripts
COPY *.html *.js *.css ./
COPY mont-logo.svg ./

RUN pip install --no-cache-dir -r requirements.txt \
    && mkdir -p /app/data /backups

EXPOSE 8000
VOLUME ["/app/data"]

CMD ["python", "backend/server.py"]
