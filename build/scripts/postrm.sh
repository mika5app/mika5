#!/bin/bash
# MIKA5 deb post-remove script

if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi
