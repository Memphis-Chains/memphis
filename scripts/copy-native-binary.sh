#!/usr/bin/env bash
set -e

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
TARGET="crates/memphis-napi/${PLATFORM}-${ARCH}.node"

# Skip if pre-built binary already exists
if [ -f "$TARGET" ]; then
  echo "Pre-built binary already exists: $TARGET"
  exit 0
fi

# Find and copy the built library
echo "Copying native binary to: $TARGET"

if [ -f "target/release/libmemphis_napi.so" ]; then
  cp target/release/libmemphis_napi.so "$TARGET"
elif [ -f "target/release/libmemphis_napi.dylib" ]; then
  cp target/release/libmemphis_napi.dylib "$TARGET"
elif [ -f "target/release/memphis_napi.dll" ]; then
  cp target/release/memphis_napi.dll "$TARGET"
else
  echo "Warning: Could not find built NAPI library, skipping copy"
  echo "This is normal if you don't have Rust installed and are using pre-built binaries"
fi
