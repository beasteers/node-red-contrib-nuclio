FROM nodered/node-red:latest-18

# USER root
# RUN apk add python3 py3-pip
# # RUN apt-get install -y python3.11 python3-pip
# RUN python3 -m pip install -U "ray[default,serve]"
# USER node-red

# FOR TESTING
RUN npm install node-red-contrib-postgresql
# 

# Install
RUN mkdir app
COPY package*.json app/
RUN npm install ./app
COPY lib app/lib

# Settings
COPY config/settings.js /data/settings.js