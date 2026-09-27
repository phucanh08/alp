# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG ALP_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/alp-src
COPY . .

RUN set -eux; \
    if [ -n "${ALP_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${ALP_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/alp-packs; \
    npm pack --workspace=@alp/highlight --pack-destination /tmp/alp-packs; \
    npm pack --workspace=@alp/relay --pack-destination /tmp/alp-packs; \
    npm pack --workspace=@alp/protocol --pack-destination /tmp/alp-packs; \
    npm pack --workspace=@alp/client --pack-destination /tmp/alp-packs; \
    npm pack --workspace=@alp/plugin --pack-destination /tmp/alp-packs; \
    npm pack --workspace=@alp/server --pack-destination /tmp/alp-packs; \
    npm pack --workspace=@alp/cli --pack-destination /tmp/alp-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/alp \
    ALP_HOME=/home/alp/.alp \
    ALP_LISTEN=0.0.0.0:6767 \
    ALP_WEB_UI_ENABLED=true \
    ALP_LOG_FORMAT=json \
    ALP_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/alp/.claude \
    CODEX_HOME=/home/alp/.codex \
    XDG_CONFIG_HOME=/home/alp/.config \
    XDG_DATA_HOME=/home/alp/.local/share \
    XDG_STATE_HOME=/home/alp/.local/state \
    XDG_CACHE_HOME=/home/alp/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/alp-packs /tmp/alp-packs
RUN set -eux; \
	npm install -g /tmp/alp-packs/*.tgz; \
    rm -rf /tmp/alp-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@alp/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/alp-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "alp" ]; then \
      groupmod --new-name alp "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 alp; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "alp" ]; then \
      usermod --login alp --gid alp --home /home/alp --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid alp --create-home --home-dir /home/alp --shell /bin/bash alp; \
    fi; \
    mkdir -p \
      /workspace \
      "$ALP_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R alp:alp /home/alp /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/alp-docker-entrypoint

WORKDIR /workspace

EXPOSE 6767
VOLUME ["/home/alp"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.ALP_LISTEN||'0.0.0.0:6767'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6767; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/alp-docker-entrypoint"]
