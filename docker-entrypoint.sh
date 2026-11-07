#!/bin/sh
# Trusts any extra root certificates mounted at /certs (a company proxy that
# inspects TLS re-signs every site with its own root, so curl, git, npm, pip and
# the agents all fail with "self-signed certificate in certificate chain").
# Runs as the vaultos user, so instead of update-ca-certificates it writes one
# bundle (Debian's roots plus the extra ones) to /tmp and points every tool at it.
# The terminals inherit this environment from the server.
set -eu

CERTS=/certs
SYSTEM=/etc/ssl/certs/ca-certificates.crt
BUNDLE=/tmp/vaultos-ca-bundle.pem

extra=0
if [ -d "$CERTS" ]; then
  cp "$SYSTEM" "$BUNDLE"
  for f in "$CERTS"/*.crt "$CERTS"/*.pem "$CERTS"/*.cer; do
    [ -f "$f" ] || continue
    # Windows exports either Base-64 (PEM, often with CRLF) or DER (binary).
    if pem="$(openssl x509 -in "$f" 2>/dev/null)" || pem="$(openssl x509 -inform DER -in "$f" 2>/dev/null)"; then
      printf '%s\n' "$pem" >> "$BUNDLE"
      extra=$((extra + 1))
    else
      echo "vaultos: skipped $f (not a certificate openssl can read)" >&2
    fi
  done
fi

if [ "$extra" -gt 0 ]; then
  echo "vaultos: trusting $extra extra certificate(s) from $CERTS" >&2
  export SSL_CERT_FILE="$BUNDLE" CURL_CA_BUNDLE="$BUNDLE" GIT_SSL_CAINFO="$BUNDLE" \
    REQUESTS_CA_BUNDLE="$BUNDLE" PIP_CERT="$BUNDLE" NPM_CONFIG_CAFILE="$BUNDLE"
  # Node adds these to its built-in roots; a value set on the container wins.
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$BUNDLE}"
else
  rm -f "$BUNDLE"
fi

exec "$@"
