FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p data uploads
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
