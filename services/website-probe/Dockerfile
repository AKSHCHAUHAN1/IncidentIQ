FROM --platform=linux/arm64 node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
CMD ["node", "index.js"]
