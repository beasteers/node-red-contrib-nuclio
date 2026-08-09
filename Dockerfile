FROM nodered/node-red:latest-20

# Install
RUN mkdir app
COPY package*.json app/
RUN npm install ./app
COPY lib app/lib

COPY scripts app/scripts

# Settings
COPY config/settings.js /data/settings.js