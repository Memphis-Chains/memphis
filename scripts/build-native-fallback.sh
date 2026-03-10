#!/usr/bin/env bash
set -e

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
BINARY_NAME="crates/memphis-napi/${PLATFORM}-${ARCH}.node"

# If pre-built binary exists, we're done
if [ -f "$BINARY_NAME" ]; then
  echo "Using pre-built binary: $BINARY_NAME"
  exit 0
fi

echo "Pre-built binary not found at $BINARY_NAME"
echo "Compiling from source..."

# Load cargo if available
source $HOME/.cargo/env 2>/dev/null || true

# Build the NAPI crate
cargo build --release -p memphis-napi

# Find and copy the built library
FOUND=0
for ext in so dylib dll; do
  if [ -f "target/release/libmemphis_napi.$ext" ]; then
    cp "target/release/libmemphis_napi.$ext" "$BINARY_NAME"
    FOUND=1
    break
  fi
done

if [ $FOUND -eq 0 ]; then
  echo "ERROR: Could not find built NAPI library in target/release/"
  echo "Expected: libmemphis_napi.so or libmemphis_napi.dylib"
  ls -la target/release/ | grep memphis || true
  exit 1
fi

echo "Copied native binary to: $BINARY_NAME"
