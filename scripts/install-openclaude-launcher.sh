#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.local/bin"
TARGET_PATH="${TARGET_DIR}/openclaude"
MARKER="# managed-by-openclaude-launcher"

mkdir -p "${TARGET_DIR}"

if [[ -f "${TARGET_PATH}" ]] && ! grep -q "${MARKER}" "${TARGET_PATH}"; then
  echo "openclaude launcher install skipped: existing ${TARGET_PATH} is not managed by this project."
  echo "If you want this project to manage it, remove that file and run: bun install"
  exit 0
fi

cat > "${TARGET_PATH}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
${MARKER}

REPO_DIR="${REPO_DIR}"
BUN_BIN="\${BUN_BIN:-${HOME}/.bun/bin/bun}"

if [[ ! -x "\${BUN_BIN}" ]]; then
  echo "openclaude launcher error: bun not found at \${BUN_BIN}" >&2
  exit 1
fi

cd "\${REPO_DIR}"
exec "\${BUN_BIN}" run ./src/bootstrap-entry.ts "\$@"
EOF

chmod +x "${TARGET_PATH}"

echo "Installed openclaude launcher at ${TARGET_PATH}"
