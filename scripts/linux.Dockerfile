# Builds Lantern's Linux packages (deb, rpm, AppImage) from any OS with Docker:
#   docker build -t lantern-linux -f scripts/linux.Dockerfile scripts
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist-linux:/out" lantern-linux
# Pass -e TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) to also sign them for auto-updates
# (scripts/release.mjs does this for you).
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
    mkdir -p /build && cd /src && tar --exclude=./node_modules --exclude=./src-tauri/target --exclude=./src-tauri/gen --exclude=./dist --exclude=./release --exclude=./hub/target -cf - . | tar -xf - -C /build; \
    cd /build && npm ci; \
    if [ -n "$TAURI_SIGNING_PRIVATE_KEY" ]; then echo '{"bundle":{"createUpdaterArtifacts":true}}' > /tmp/updater.json; set -- --config /tmp/updater.json; fi; \
    npx tauri build "$@"; \
    cd src-tauri/target/release/bundle && cp deb/*.deb rpm/*.rpm appimage/*.AppImage /out/ && (cp deb/*.sig rpm/*.sig appimage/*.sig /out/ 2>/dev/null || true)
