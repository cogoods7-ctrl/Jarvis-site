#!/bin/bash
# JARVIS Helper Script
# Runs AppleScript commands passed as arguments.
# macOS grants Accessibility to Terminal/bash, not to Electron directly.
# Usage: jarvis_helper.sh "applescript code here"
osascript -e "$1"
