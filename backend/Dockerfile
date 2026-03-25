FROM node:25-alpine3.23

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY . .
#compile ts to dist
RUN npm run build
#remove dependencies after build
RUN npm prune --omit=dev

EXPOSE 3000
CMD ["node", "dist/server.js"]