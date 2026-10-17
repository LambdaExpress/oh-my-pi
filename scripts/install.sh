#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/LambdaExpress/oh-my-pi/release/scripts/install.sh | sh
#
# Options:
#   --source       Install via bun (installs bun if needed; defaults to dev)
#   --binary       Always install prebuilt binary (the default)
#   --ref <ref>    Any tag/commit/branch in source mode; code-N or v<version>
#                  in binary mode
#   -r <ref>       Shorthand for --ref
#
# Default/code-N binaries come from the fork's GitHub Releases. Explicit
# v<version> refs or PI_BUILD_URL select the build service (default
# https://build.stencil.so). Both verify sha256 before replacing an install.
# Build-service files must also match the host asset name and exact byte size.

REPO="LambdaExpress/oh-my-pi"
PACKAGE="@oh-my-pi/pi-coding-agent"
if [ -n "${PI_INSTALL_DIR:-}" ]; then
    INSTALL_DIR="$PI_INSTALL_DIR"
else
    INSTALL_DIR="$HOME/.local/bin"
    EXISTING_OMP="$(command -v omp 2>/dev/null || true)"
    case "$EXISTING_OMP" in
        /*)
            EXISTING_DIR="$(dirname "$EXISTING_OMP")"
            if [ -w "$EXISTING_DIR" ]; then INSTALL_DIR="$EXISTING_DIR"; fi
            ;;
    esac
fi
BUILD_URL="${PI_BUILD_URL:-https://build.stencil.so}"
while [ "${BUILD_URL%/}" != "$BUILD_URL" ]; do
    BUILD_URL="${BUILD_URL%/}"
done
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Default to the latest fork release binary. Source installs follow `dev`.
if [ -z "$MODE" ]; then
    MODE="binary"
fi
if [ "$MODE" = "source" ] && [ -z "$REF" ]; then
    REF="dev"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Normalized host architecture, including native Apple Silicon under Rosetta.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
}

version_ge() {
    current="$1"
    minimum="$2"
    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"
    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"
    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi
    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi
    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi
    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

has_git() {
    command -v git >/dev/null 2>&1
}

install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi
        TMP_DIR="$(mktemp -d)"
        trap 'rm -rf "$TMP_DIR"' EXIT
        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi
        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            echo "Expected package at ${TMP_DIR}/packages/coding-agent"
            exit 1
        fi
        bun install -g "$TMP_DIR/packages/coding-agent" || {
            echo "Failed to install from source"
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            echo "Failed to install $PACKAGE"
            exit 1
        }
    fi
    echo ""
    echo "✓ Installed omp via bun"
    echo "Run 'omp' to get started!"
}

# String field in one-line JSON; escaped quotes cannot fake a key.
json_string() {
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# Select the answer's top-level file, not another target in build.files[].
json_file_object() {
    sed -n 's/.*"file"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p'
}

# Match the service's positive safe-integer JSON number contract.
json_file_size() {
    sed -n 's/.*"size"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p' | LC_ALL=C awk '
        {
            gsub(/^[[:space:]]+|[[:space:]]+$/, "")
            if ($0 !~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/) exit
            size = $0 + 0
            if (size > 0 && size <= 9007199254740991 && size == int(size)) printf "%.0f\n", size
        }
    '
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

install_binary() {
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
        echo "sha256sum or shasum is required to verify the downloaded binary"
        exit 1
    fi
    OS="$(uname -s)"
    ARCH="$(host_arch)"
    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac
    case "$ARCH" in
        x64|arm64) ;;
        *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi
    BINARY="omp-${PLATFORM}-${ARCH}"

    USE_BUILD_SERVICE=false
    case "$REF" in
        code-*) ;;
        v*) USE_BUILD_SERVICE=true ;;
        "") if [ -n "${PI_BUILD_URL:-}" ]; then USE_BUILD_SERVICE=true; fi ;;
        *)
            echo "Binary installs take a release tag (code-N or v<version>) for --ref, got: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
            ;;
    esac
    RELEASE_CODE=""
    EXPECTED_SIZE=""
    if [ "$USE_BUILD_SERVICE" = true ]; then
        SERVICE_PLATFORM="$PLATFORM"
        if [ "$SERVICE_PLATFORM" = "darwin" ]; then SERVICE_PLATFORM="macos"; fi
        TARGET_ARCH="$ARCH"
        if [ "$TARGET_ARCH" = "x64" ]; then TARGET_ARCH="x86_64"; fi
        TARGET="${SERVICE_PLATFORM}-${TARGET_ARCH}"
        if [ -n "$REF" ]; then
            if ! printf '%s\n' "$REF" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
                echo "Binary installs take a release tag (v<version>) for --ref, got: $REF"
                echo "For branch/commit installs, use --source with --ref."
                exit 1
            fi
            echo "Fetching omp ${REF#v}..."
            API_URL="${BUILD_URL}/api/products/omp/versions/${REF#v}/${TARGET}"
        else
            echo "Fetching latest release..."
            API_URL="${BUILD_URL}/api/products/omp/latest/${TARGET}?channel=stable"
        fi
        if ! BUILD_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "$API_URL"); then
            echo "Failed to resolve an omp build for ${TARGET} from ${API_URL}"
            exit 1
        fi
        BUILD_JSON=$(printf '%s' "$BUILD_JSON" | tr -d '\r\n')
        VERSION=$(printf '%s\n' "$BUILD_JSON" | json_string version)
        FILE_JSON=$(printf '%s\n' "$BUILD_JSON" | json_file_object)
        ANSWERED_BINARY=$(printf '%s\n' "$FILE_JSON" | json_string name)
        EXPECTED_SIZE=$(printf '%s\n' "$FILE_JSON" | json_file_size)
        EXPECTED_SHA256=$(printf '%s\n' "$FILE_JSON" | json_string sha256)
        # Go escapes ampersands in presigned URLs as \u0026.
        DOWNLOAD_URL=$(printf '%s\n' "$BUILD_JSON" | json_string download | sed 's/\\u0026/\&/g')
        if [ -z "$VERSION" ] || [ -z "$DOWNLOAD_URL" ]; then
            echo "Unexpected answer from ${API_URL}"
            exit 1
        fi
        if [ "$ANSWERED_BINARY" != "$BINARY" ]; then
            echo "Answered file ${ANSWERED_BINARY} is not ${BINARY}"
            exit 1
        fi
        if [ -z "$EXPECTED_SIZE" ]; then
            echo "Missing or invalid size for ${BINARY}"
            exit 1
        fi
    else
        if [ -n "$REF" ]; then
            LATEST="$REF"
        else
            echo "Fetching latest code release..."
            RELEASES_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases?per_page=100")
            LATEST=$(printf '%s\n' "$RELEASES_JSON" \
                | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"code-[0-9][0-9]*"' \
                | sed -E 's/.*"(code-[0-9]+)"/\1/' \
                | sort -t- -k2,2nr \
                | sed -n '1p')
        fi
        if ! printf '%s\n' "$LATEST" | grep -Eq '^code-[1-9][0-9]*$'; then
            echo "Failed to find a valid code-N release tag"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
        RELEASE_CODE="${LATEST#code-}"
        if ! RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${LATEST}"); then
            echo "Release tag not found: $LATEST"
            exit 1
        fi
        VERSION="$LATEST"
        # Code releases publish complete digests in their Release body.
        CHECKSUMS=$(printf '%s\n' "$RELEASE_JSON" | json_string body | sed 's/\\r//g; s/\\n/\
/g')
        EXPECTED_SHA256=$(printf '%s\n' "$CHECKSUMS" | while read -r digest asset; do
            if [ "$asset" = "$BINARY" ]; then printf '%s\n' "$digest"; fi
        done)
        DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    fi
    if ! printf '%s\n' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-f]{64}$' || [ "${#EXPECTED_SHA256}" -ne 64 ]; then
        echo "Missing or invalid SHA256 for ${BINARY}"
        exit 1
    fi
    echo "Using version: $VERSION"

    mkdir -p "$INSTALL_DIR"
    TARGET_PATH="${INSTALL_DIR}/omp"
    ATTEMPT="$(date +%s).$$"
    NEW_PATH="${TARGET_PATH}.${ATTEMPT}.new"
    BACKUP_PATH="${TARGET_PATH}.${ATTEMPT}.bak"
    trap 'rm -f "$NEW_PATH"' EXIT
    echo "Downloading ${BINARY}..."
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$DOWNLOAD_URL" -o "$NEW_PATH"
    if [ -n "$EXPECTED_SIZE" ]; then
        ACTUAL_SIZE=$(wc -c < "$NEW_PATH" | tr -d '[:space:]')
        if [ "$ACTUAL_SIZE" != "$EXPECTED_SIZE" ]; then
            echo "Size mismatch for ${BINARY}: expected ${EXPECTED_SIZE} bytes, got ${ACTUAL_SIZE}"
            exit 1
        fi
    fi
    ACTUAL_SHA256="$(sha256_of "$NEW_PATH")"
    if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
        echo "Checksum mismatch for ${BINARY}: expected ${EXPECTED_SHA256}, got ${ACTUAL_SHA256}"
        exit 1
    fi
    chmod +x "$NEW_PATH"
    # Smoke the staged executable before touching the installed one. Musl
    # binaries may download successfully but fail without libstdc++/libgcc.
    if ! SMOKE_OUTPUT="$("$NEW_PATH" --version 2>&1)"; then
        echo ""
        echo "✗ Downloaded omp cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'omp':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi
    if [ -n "$RELEASE_CODE" ] && ! printf '%s\n' "$SMOKE_OUTPUT" | grep -q "+code\.${RELEASE_CODE}$"; then
        echo "Downloaded omp reports an unexpected release code: $SMOKE_OUTPUT"
        exit 1
    fi
    HAD_BACKUP=0
    if [ -e "$TARGET_PATH" ]; then
        mv "$TARGET_PATH" "$BACKUP_PATH"
        HAD_BACKUP=1
    fi
    if ! mv "$NEW_PATH" "$TARGET_PATH"; then
        if [ "$HAD_BACKUP" -eq 1 ]; then mv "$BACKUP_PATH" "$TARGET_PATH"; fi
        exit 1
    fi
    if [ "$HAD_BACKUP" -eq 1 ]; then rm -f "$BACKUP_PATH"; fi
    echo ""
    echo "✓ Installed omp to $TARGET_PATH"
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp'" ;;
    esac
}

case "$MODE" in
    source)
        if ! has_bun; then install_bun; fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_via_bun
        ;;
    *)
        # Never let an existing Bun route the default through upstream npm.
        install_binary
        ;;
esac
