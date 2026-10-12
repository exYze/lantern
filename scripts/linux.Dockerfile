# Builds Lantern's Linux packages (deb, rpm, AppImage) from any OS with Docker:
#   docker build -t lantern-linux -f scripts/linux.Dockerfile scripts
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist-linux:/out" lantern-linux
FROM rust:1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
      patchelf file rpm xdg-utils curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# linuxdeploy (used for AppImages) cannot mount FUSE inside a container.
ENV APPIMAGE_EXTRACT_AND_RUN=1 CI=true

CMD set -e; \
    mkdir -p /build && cd /src && tar --exclude=./node_modules --exclude=./src-tauri/target --exclude=./src-tauri/gen --exclude=./dist -cf - . | tar -xf - -C /build; \
    cd /build && npm ci && npx tauri build; \
    cp src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/rpm/*.rpm src-tauri/target/release/bundle/appimage/*.AppImage /out/
