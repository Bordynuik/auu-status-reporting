FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Set production environment
ENV NODE_ENV=production
ENV DATA_DIR=/usr/src/app/data

# Copy package manifest and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy app sources
COPY . .

# Ensure data directory exists and is writable
RUN mkdir -p ${DATA_DIR} && chown -R node:node /usr/src/app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

USER node

EXPOSE 3000

VOLUME ["/usr/src/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["npm", "start"]
