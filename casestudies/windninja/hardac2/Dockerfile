# WindNinja command-line build, same commit and options as the 2026-11-07 baseline.
# Build:  docker build -t windninja-cli:38fc7ca .
FROM ubuntu:24.04
ARG WINDNINJA_COMMIT=38fc7ca2650f9665cf62e00984880705fe3ddd55
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git cmake g++ make pkg-config gdal-bin libgdal-dev libnetcdf-dev \
      libboost-program-options-dev libboost-date-time-dev libboost-test-dev \
      libshp-dev libcurl4-gnutls-dev libgeos-dev libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/firelab/windninja.git /opt/windninja \
    && git -C /opt/windninja checkout "$WINDNINJA_COMMIT"
RUN mkdir /opt/build && cd /opt/build \
    && cmake /opt/windninja -DUSE_VCPKG_MANIFEST=OFF -DNINJA_GUI=OFF -DNINJAFOAM=OFF \
         -DSUPRESS_WARNINGS=ON -DBUILD_FETCH_DEM=ON -DCMAKE_BUILD_TYPE=Release \
    && make -j"$(nproc)"
ENV WINDNINJA_DATA=/opt/windninja/data
ENV PATH=/opt/build/src/cli:$PATH
COPY download-tests.sh /usr/local/bin/download-tests.sh
RUN chmod +x /usr/local/bin/download-tests.sh
WORKDIR /results
ENTRYPOINT ["/usr/local/bin/download-tests.sh"]
