FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY concord.png logo-concord.png Gemini_Generated_Image_nh6wb4nh6wb4nh6w.jpg ./

RUN mkdir -p /app/data/uploads

ENV NODE_ENV=production
ENV PORT=3456
ENV HOST=0.0.0.0
ENV CONCORD_INVITE_CODE=CONCORD-AMIGOS-2026

EXPOSE 3456

VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
