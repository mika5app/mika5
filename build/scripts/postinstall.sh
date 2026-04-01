#!/bin/bash
# MIKA5 deb post-install script
# Updates desktop database and icon cache

if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi

if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache /usr/share/icons/hicolor || true
fi
