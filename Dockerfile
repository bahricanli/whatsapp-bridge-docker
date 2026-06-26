FROM node:20-alpine

# ffmpeg: OGG/OPUS ses notlarını Whisper için WAV'a çevirir
RUN apk add --no-cache python3 make g++ git ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install

COPY bridge.js ./

# Auth state persisted via volume at /data/auth
VOLUME ["/data/auth"]

EXPOSE 3000

CMD ["node", "bridge.js"]
