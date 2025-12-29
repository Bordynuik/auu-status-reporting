# AUU Reporting — Docker instructions

Build the backend Docker image from the `backend/` directory:

```bash
docker build -t auu-backend:latest .
```

Run the container, exposing port 3000 and persisting DB/logs in a named volume:

```bash
docker run -d \
  --name auu-backend \
  -p 3000:3000 \
  -e DATA_DIR=/usr/src/app/data \
  -v auu_data:/usr/src/app/data \
  auu-backend:latest
```

Notes:
- The container listens on `PORT` (defaults to `3000`).
- The app stores the SQLite DB and `server.log` in the directory referenced by `DATA_DIR` (default `/usr/src/app/data`). Mount a volume there to persist state.
- For local development you can mount the project folder instead, but if you mount the whole app directory you may need to `npm install` on the host or adjust volume mounts for `node_modules`.

Healthcheck: the image exposes a Docker health check at `/api/health`.
