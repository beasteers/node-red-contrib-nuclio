ARG NUCLIO_VERSION=1.17.3
ARG NUCLIO_ARCH=amd64
ARG NUCLIO_ONBUILD_IMAGE=quay.io/nuclio/handler-builder-python-onbuild:${NUCLIO_VERSION}-${NUCLIO_ARCH}

FROM ${NUCLIO_ONBUILD_IMAGE} AS processor
FROM python:3.12-slim

COPY --from=processor /home/nuclio/bin/processor /usr/local/bin/processor
COPY --from=processor /home/nuclio/bin/py /opt/nuclio/
COPY --from=processor /home/nuclio/bin/py*-whl/* /opt/nuclio/whl/

RUN python /opt/nuclio/whl/$(basename /opt/nuclio/whl/pip-*.whl)/pip install pip --no-index --find-links /opt/nuclio/whl \
    && python -m pip install --no-cache-dir msgpack \
    && python -m pip install nuclio-sdk --no-index --find-links /opt/nuclio/whl

COPY main.py /opt/nuclio/main.py
CMD ["processor"]
