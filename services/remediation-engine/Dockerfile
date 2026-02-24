FROM node:18

# install docker CLI
RUN apt-get update && \
    apt-get install -y docker.io && \
    apt-get clean

WORKDIR /app

COPY package.json .
RUN npm install

COPY src ./src

CMD ["node", "src/index.js"]