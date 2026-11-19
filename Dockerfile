# Stage 1: Install production dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: Runtime image
FROM node:20-alpine
WORKDIR /app

# Copy installed dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create the upload folders and give the non-root "node" user write access
RUN mkdir -p /app/uploads/profiles && chown -R node:node /app/uploads

# Run as non-root user
USER node

# App defaults to port 6500 (overridable via ENV/compose)
ENV PORT=6500
EXPOSE 6500

CMD ["node", "index.js"]