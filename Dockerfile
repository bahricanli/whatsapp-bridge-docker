FROM node:20-alpine

# Dependencies for Baileys native modules
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY bridge.js ./

# Auth state persisted via volume at /data/auth
VOLUME ["/data/auth"]

EXPOSE 3000

CMD ["node", "bridge.js"]
