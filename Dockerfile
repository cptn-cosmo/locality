FROM node:24-alpine
WORKDIR /app
COPY package.json server.js config.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
EXPOSE 8787
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO /dev/null http://127.0.0.1:8787/api/locations || exit 1
CMD ["node", "server.js"]
