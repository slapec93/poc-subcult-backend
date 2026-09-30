FROM node:24-alpine
RUN npm install -g pnpm@10.29.2
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
ARG PKG
WORKDIR /app/packages/${PKG}
CMD ["pnpm", "start"]
