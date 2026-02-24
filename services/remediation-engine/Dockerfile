FROM node:18

# install latest docker CLI
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://get.docker.com | sh

WORKDIR /app

COPY package.json .
RUN npm install

COPY src ./src

CMD ["node", "src/index.js"]