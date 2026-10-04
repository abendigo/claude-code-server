#!/bin/sh
set -e

# Seed the served client directory from the image on first run (or when
# forced). After that the volume is authoritative -- edit it with vr-sync
# from a worker -- so redeploying the image never clobbers live edits.
if [ ! -f /srv/client/index.html ] || [ "${VR_RESEED:-}" = "1" ]; then
    echo "Seeding /srv/client from the image's default client."
    cp -R /app/client-default/. /srv/client/
    chmod -R a+rwX /srv/client 2>/dev/null || true
fi

exec node /app/server/server.js
