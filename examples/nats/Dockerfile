FROM nodered/node-red:5.0.4-24

USER root
WORKDIR /usr/src/node-red
RUN mkdir -p app
COPY package*.json app/
COPY lib app/lib
COPY resources app/resources
COPY scripts app/scripts
RUN npm install --omit=dev --no-audit --no-fund ./app

# Keep the NATS Suite dependency in the image's module path. The Compose
# example mounts /data for the flow, so installing it there would hide it.
RUN npm install --omit=dev --no-audit --no-fund node-red-contrib-nats-suite@0.2.2

COPY config/settings.js /data/settings.js
USER node-red
