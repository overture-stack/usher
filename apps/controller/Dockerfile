# The Usher Controller's image, built with the repository's root as its context, where the workspace's
# manifests and lockfile live:
#
#     docker build --file apps/controller/Dockerfile .
#
# One image runs both of the controller's commands, chosen by the image's arguments: the controller
# by default, `dist/main.js`, and the schema migration command, `dist/migrate.js`.

# node:26.13.0-trixie-slim, the multi-platform index (linux/amd64 and linux/arm64 among its platforms).
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build

WORKDIR /usher

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# pnpm, at the version the root manifest's packageManager names, as the native build pnpm publishes
# for this platform. The archive npm fetches must match the integrity the lockfile records for it,
# so the binary run is the one the workspace pinned.
RUN set -eu; \
    version="$(node --print "require('./package.json').packageManager.split('+')[0].split('@')[1]")"; \
    package="@pnpm/exe.linux-$(node --print process.arch)@${version}"; \
    archive="$(npm pack --silent "${package}")"; \
    expected="$(grep --after-context=1 "^  '${package}':" pnpm-lock.yaml | sed -n 's/.*integrity: \(sha512-[^}]*\)}.*/\1/p')"; \
    actual="sha512-$(node --eval "process.stdout.write(require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync(process.argv[1])).digest('base64'))" "${archive}")"; \
    if [ -z "${expected}" ] || [ "${actual}" != "${expected}" ]; then \
      echo "${package} does not match the integrity pnpm-lock.yaml records for it" >&2; \
      exit 1; \
    fi; \
    tar --extract --gzip --file="${archive}" --directory=/usr/local/bin --strip-components=1 package/pnpm; \
    rm "${archive}"; \
    pnpm --version

# Every workspace package's manifest, so the install resolves the workspace as the lockfile records
# it; the libraries' sources are left out, since the controller imports only their types.
COPY apps/controller/package.json apps/controller/
COPY modules/express-bridge/package.json modules/express-bridge/
COPY modules/types/package.json modules/types/

# The workspace's settings in pnpm-workspace.yaml apply here as on any machine: the release age,
# the trust policy, the block on exotic subdependencies and the refusal of unreviewed build scripts.
RUN pnpm install --frozen-lockfile

COPY apps/controller/ apps/controller/

# The controller's production dependencies alone, beside the build `deploy` copies with the package.
RUN pnpm --filter @overture-stack/usher-controller build \
 && pnpm --filter @overture-stack/usher-controller deploy --prod --frozen-lockfile /deploy

# gcr.io/distroless/nodejs26-debian13:nonroot, the multi-platform index (linux/amd64 and linux/arm64
# among its platforms).
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8 AS runtime

WORKDIR /app

# The manifest declares "type": "module", so Node loads the build's .js files as ES modules.
COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/dist ./dist

USER 65532:65532

ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/main.js"]
