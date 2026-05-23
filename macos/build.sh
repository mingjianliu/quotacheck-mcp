#!/bin/bash
set -e

APP_NAME="Quotacheck"
APP_DIR="$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

echo "Building $APP_NAME..."

# Create directory structure
mkdir -p "$MACOS_DIR"

# Compile Swift code
# -parse-as-library is required for @main in a single file
swiftc App.swift -parse-as-library -o "$MACOS_DIR/$APP_NAME"

# Create Info.plist
cat <<EOF > "$CONTENTS_DIR/Info.plist"
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
    <!-- Hides the dock icon -->
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF

echo "Done! You can launch the app with: open $APP_DIR"
