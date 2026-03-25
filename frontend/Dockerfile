FROM node:25-alpine3.23 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine3.23-perl
COPY --from=builder /app/dist /usr/share/nginx/html