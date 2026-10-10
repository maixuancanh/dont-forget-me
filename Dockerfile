FROM public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
COPY web/ /app/web/
ENV NODE_ENV=production HOST=0.0.0.0
EXPOSE 8798
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
