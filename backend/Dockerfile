# BEACON backend — development image
# Build context is the repository root (npm workspaces require the root manifest).
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json

RUN npm install

COPY backend backend

WORKDIR /app/backend

EXPOSE 4000

CMD ["npm", "run", "dev"]
