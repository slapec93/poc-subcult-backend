FROM node:24-alpine
# Node gives each address 250 ms by default; Docker Desktop's NAT can take longer to connect.
ENV NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000
RUN npm install -g pnpm@10.29.2
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
ARG PKG
WORKDIR /app/packages/${PKG}
CMD ["pnpm", "start"]
