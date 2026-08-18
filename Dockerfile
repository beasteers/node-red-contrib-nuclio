FROM nodered/node-red:5.0.4-24
# Install
RUN mkdir app
COPY package*.json app/
RUN npm install ./app
COPY lib app/lib

COPY scripts app/scripts

# Settings
COPY config/settings.js /data/settings.js