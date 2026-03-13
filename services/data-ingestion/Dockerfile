FROM node:20-alpine

# Python for collector_scheduler.py, fetch_crux_baselines.py, etc.
RUN apk add --no-cache python3 py3-pip
COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY src ./src

EXPOSE 4000

CMD ["npm", "start"]
