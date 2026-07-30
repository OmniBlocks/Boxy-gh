FROM node:20-slim
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client sshpass && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --production
RUN npm cache clean --force
ENV NODE_ENV="production"
COPY . .
CMD [ "npm", "start" ]
