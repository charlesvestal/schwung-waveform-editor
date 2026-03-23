#!/usr/bin/env bash
# Build Wave Edit module for Schwung
#
# Cross-compiles the DSP plugin and packages all files for release.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
MODULE_ID="waveform-editor"

# Cross-compilation prefix (aarch64 Linux target)
CROSS_PREFIX="${CROSS_PREFIX:-aarch64-linux-gnu-}"

cd "$REPO_ROOT"

echo "=== Building Wave Edit Module ==="

# Compile DSP plugin
echo "Compiling DSP..."
mkdir -p build
${CROSS_PREFIX}gcc -Ofast -shared -fPIC \
    -march=armv8-a -mtune=cortex-a72 \
    -fomit-frame-pointer -fno-stack-protector \
    -DNDEBUG \
    src/dsp/plugin.c \
    -o build/dsp.so \
    -Isrc/dsp \
    -lm

# Create dist directory
rm -rf "dist/$MODULE_ID"
mkdir -p "dist/$MODULE_ID"

# Copy module files
echo "Packaging..."
cp src/module.json "dist/$MODULE_ID/"
cp src/ui.js "dist/$MODULE_ID/"
cp build/dsp.so "dist/$MODULE_ID/"
[ -f src/help.json ] && cp src/help.json "dist/$MODULE_ID/"
chmod +x "dist/$MODULE_ID/dsp.so"

# Create tarball for release
cd dist
tar -czvf "$MODULE_ID-module.tar.gz" "$MODULE_ID/"
cd ..

echo ""
echo "=== Build Complete ==="
echo "Output: dist/$MODULE_ID/"
echo "Tarball: dist/$MODULE_ID-module.tar.gz"
echo ""
echo "To install on Move:"
echo "  ./scripts/install.sh"
