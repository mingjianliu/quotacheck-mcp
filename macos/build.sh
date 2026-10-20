#!/bin/bash
set -e

# Build from this directory regardless of where the script is invoked from.
cd "$(dirname "$0")"

APP_NAME="Quotacheck"
APP_DIR="$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

echo "Building $APP_NAME..."

# Create directory structure
mkdir -p "$MACOS_DIR"

# Compile Swift code
# -parse-as-library is required for @main in a single file.
# Extra compiler flags pass through SWIFTC_FLAGS, e.g. when the default SDK fails:
#   SWIFTC_FLAGS="-sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk -target arm64-apple-macosx15.0" ./build.sh
# shellcheck disable=SC2086
swiftc App.swift -parse-as-library $SWIFTC_FLAGS -o "$MACOS_DIR/$APP_NAME"

# Create Info.plist
cat <<PLIST > "$CONTENTS_DIR/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>com.mingjianliu.quotacheck</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <!-- Hides the dock icon -->
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

echo "Done! You can launch the app with: open $(pwd)/$APP_DIR"
