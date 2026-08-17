# Build stage: TypeScript needs devDependencies, the runtime does not.
FROM apify/actor-node:22 AS builder

COPY --chown=myuser package*.json ./
RUN npm install --include=dev --audit=false --fund=false

COPY --chown=myuser . ./
RUN npm run build

# Runtime stage: production dependencies plus the compiled output only.
FROM apify/actor-node:22

COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --audit=false --fund=false \
    && echo "Installed npm packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version

COPY --chown=myuser --from=builder /usr/src/app/dist ./dist
COPY --chown=myuser .actor ./.actor

# No browser engine is installed, and none is needed — the Actor speaks HTTP only.
CMD ["node", "dist/actor/main.js"]
