#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
install_dir="${HOME}/.local/bin"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bin-dir)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo 'Error: --bin-dir requires a directory.' >&2
        exit 1
      fi
      install_dir="$2"
      shift 2
      ;;
    -h|--help)
      echo 'Usage: bash scripts/install.sh [--bin-dir DIRECTORY]'
      echo 'Build and install defi-tool to ~/.local/bin, with no sudo or npx required.'
      echo 'Example: bash scripts/install.sh --bin-dir "$HOME/.local/bin"'
      exit 0
      ;;
    *) echo "Error: unknown option $1. Use --help." >&2; exit 1 ;;
  esac
done

target="$install_dir/defi-tool"
source_file="$project_dir/bin/defi-tool.mjs"
if [[ -e "$target" || -L "$target" ]]; then
  if [[ ! -L "$target" || "$(readlink -- "$target")" != "$source_file" ]]; then
    echo "Error: $target already exists and belongs to another installation; choose --bin-dir." >&2
    exit 1
  fi
fi

command -v node >/dev/null || { echo 'Error: install Node.js 22.13+ first (Node.js 24 recommended).' >&2; exit 1; }
node -e 'const [major,minor] = process.versions.node.split(".").map(Number); if(major < 22 || (major === 22 && minor < 13)) { console.error("Node.js 22.13+ is required (Node.js 24 recommended)."); process.exit(1); }'
command -v npm >/dev/null || { echo 'Error: npm is required to build the CLI.' >&2; exit 1; }
if [[ ! -d "$project_dir/node_modules" ]]; then
  npm --prefix "$project_dir" ci --no-audit --no-fund
fi
npm --prefix "$project_dir" run build
mkdir -p -- "$install_dir"
chmod +x -- "$source_file"
if [[ ! -L "$target" ]]; then ln -s -- "$source_file" "$target"; fi
echo "Installed: $target"
case ":$PATH:" in
  *":$install_dir:"*) echo 'Ready: defi-tool --help' ;;
  *) printf 'Add this directory to PATH (e.g. in ~/.zshrc):\n  export PATH="%s:$PATH"\n' "$install_dir" ;;
esac
echo 'Start with: defi-tool init'
