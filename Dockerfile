# Self-contained image: runs anywhere with
#   docker run -p 127.0.0.1:7684:8080 -v <folder>:/vault -v vaultos-home:/home/vaultos vaultos:latest
# Debian (bookworm), not alpine, since the Workbench terminal: agent CLIs
# (claude etc.) are built against glibc and will not run on alpine's musl. node-pty is a native addon, so it compiles in a throwaway
# builder stage and only the built node_modules reach the runtime image.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Build against the headers the base image already ships, so node-gyp never
# downloads them from nodejs.org (a TLS-inspecting work proxy breaks that).
ENV npm_config_nodedir=/usr/local
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app

# Headless Chromium renders the Knowledge Base's "Export PDF" server-side (see
# the PDF export section of server.js). Inter + JetBrains Mono are the PDF's
# typefaces; DejaVu and Noto Emoji cover any glyph those two don't.
# git/less/procps/ca-certificates/python3 make the Workbench terminal a usable shell
# (python3: skills like diagram-design run self_check.py).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-inter fonts-jetbrains-mono fonts-dejavu-core fonts-noto-color-emoji \
    bash git less procps ca-certificates curl tini python3 python3-pip python3-venv libicu72 \
  && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
# uid 1000 is `node` in this base image; rename it `vaultos` with home
# /home/vaultos (the volume that keeps agent logins and settings).
RUN groupmod -n vaultos node && usermod -l vaultos -d /home/vaultos -m node
ENV HOME=/home/vaultos PATH=/home/vaultos/.local/bin:$PATH
# A login shell (VaultOS terminals, the agent check) resets PATH from
# /etc/profile on Debian, so ENV PATH alone would lose ~/.local/bin.
RUN printf '%s\n' \
  'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac' \
  'export PATH' > /etc/profile.d/vaultos-path.sh

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# App source (config.json / lockout.json are bind-mounted at runtime, not baked in)
COPY server.js set-password.js ./
COPY lib ./lib
COPY public ./public
COPY hooks ./hooks
# vault-search: ranked search of the vault for any agent in a terminal.
COPY bin ./bin
RUN chmod +x bin/vault-search.js && ln -s /app/bin/vault-search.js /usr/local/bin/vault-search
COPY starter-kit ./starter-kit
COPY docker-entrypoint.sh /usr/local/bin/vaultos-entrypoint

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER 1000:1000

# tini -s: PID 1 reaps zombie shells/agents and, with -s, still works when it is
# not PID 1 of the container's namespace (subreaper mode). vaultos-entrypoint
# trusts any extra root certificates mounted at /certs, then starts the server.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/vaultos-entrypoint"]
CMD ["node", "server.js"]
