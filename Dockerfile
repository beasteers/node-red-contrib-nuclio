FROM nodered/node-red:5.0.4-24

# Copy the complete local package before installing it. The package's
# resources and migration script are runtime files, not just build inputs.
RUN mkdir -p app
COPY package*.json app/
COPY lib app/lib
COPY resources app/resources
COPY scripts app/scripts
RUN npm install --omit=dev --no-audit --no-fund ./app

# Settings
COPY config/settings.js /data/settings.js
