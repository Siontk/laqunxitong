#!/bin/sh
set -eu

MAX_OLD_SPACE_MB="${MAX_OLD_SPACE_MB:-1280}"

exec node --enable-source-maps --max-old-space-size="${MAX_OLD_SPACE_MB}" dist/server.js
