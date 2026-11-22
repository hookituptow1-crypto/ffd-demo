FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080
# Mount a persistent volume at /app/data (SQLite DB, encryption key, encrypted uploads, VAPID keys)
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "src/server.js"]
