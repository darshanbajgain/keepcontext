FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings", "src/server.js"]
