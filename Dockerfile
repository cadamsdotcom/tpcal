FROM node:20-slim

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install deps, Playwright + browser, clean up in single layer
RUN npm ci --omit=dev && \
    npx playwright install --with-deps chromium && \
    chmod -R 755 /opt/playwright && \
    rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache

# Copy application code
COPY server.js ./

# Run as non-root user
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/').then(r => process.exit(r.ok ? 0 : 1))"

CMD ["node", "server.js"]
