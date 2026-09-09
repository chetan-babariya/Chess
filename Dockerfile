# Production Dockerfile for ChessApp
FROM node:22-alpine AS runner

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY server.js ./
COPY public ./public

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Fix #10: Run as non-root user
RUN addgroup -S chess && adduser -S chess -G chess
RUN chown -R chess:chess /app
USER chess

EXPOSE 3000

# Fix #10: Docker HEALTHCHECK
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Run server
CMD ["node", "server.js"]
