# YYC Brokers - Production Dockerfile
# Multi-stage build for optimized image size

# Build stage - install dependencies
FROM node:24-alpine AS build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --production --quiet

# Production stage
FROM node:24-alpine

# Create app user for security (don't run as root)
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy node_modules from build stage
COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application code
COPY --chown=nodejs:nodejs src ./src
COPY --chown=nodejs:nodejs public ./public
COPY --chown=nodejs:nodejs scripts ./scripts
COPY --chown=nodejs:nodejs package.json ./

# Environment variables (override in Render dashboard)
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

# Switch to non-root user
USER nodejs

# Expose port 3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/healthz', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"

# Start the server
CMD ["node", "src/server.js"]
