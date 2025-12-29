# AUU Reporting (Docker-ready)

This repository contains the minimal files required to build the Docker image for AUU Reporting.

Build and run:

```bash
docker build -t auu-reporting .
docker run -p 3000:3000 --env-file .env auu-reporting
```

Environment:

- Copy `.env.example` to `.env` and fill in values before running.
