#!/bin/sh
set -e

# The hub serves the client baked into this image (/app/client-default) unless
# /srv/client holds a newer vr-sync -- see clientDir() in server/server.js.
# Nothing is copied or seeded, so deploying a new image can never be blocked
# by (or clobber) what's in the volume.
exec node /app/server/server.js
