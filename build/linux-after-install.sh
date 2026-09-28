#!/bin/bash
# Post-install for the deb and rpm packages.
#
# Note this script REPLACES electron-builder's stock postinst rather than adding to it:
# `afterInstall` is handed to fpm as --after-install, and fpm accepts exactly one such
# script. Everything the stock template did must therefore be repeated here, or it is
# silently lost from the package.
#
# No `set -e`: a maintainer script that aborts leaves the package half-configured and
# needing `dpkg --configure -a`. Every step below is best-effort, exactly as the stock
# template has it.

APP='/opt/daily-diary/daily-diary'
LINK='/usr/bin/daily-diary'
SANDBOX='/opt/daily-diary/chrome-sandbox'

# The `daily-diary` command on PATH. The .desktop entry uses an absolute Exec= and so does
# not depend on this, which is what makes its absence easy to miss.
if type update-alternatives 2>/dev/null >&1; then
    # Drop a previous plain symlink so update-alternatives can take the name over.
    if [ -L "$LINK" ] && [ -e "$LINK" ] && [ "$(readlink "$LINK")" != '/etc/alternatives/daily-diary' ]; then
        rm -f "$LINK"
    fi
    update-alternatives --install "$LINK" 'daily-diary' "$APP" 100 || ln -sf "$APP" "$LINK"
else
    ln -sf "$APP" "$LINK"
fi

# Chromium aborts at startup when its setuid sandbox helper exists but is not configured
# correctly, rather than silently running unsandboxed:
#
#   FATAL: The SUID sandbox helper binary was found, but is not configured correctly.
#   /opt/daily-diary/chrome-sandbox must be owned by root and have mode 4755.
#
# The stock template chose the mode by testing user namespaces here, at install time. That
# test is misleading: postinst runs as root, and root is exempt from the AppArmor policy
# that recent Ubuntu uses to restrict unprivileged user namespaces
# (kernel.apparmor_restrict_unprivileged_userns=1). The test passed, the helper was left at
# 0755, and the app then aborted for every normal user, whose namespace creation the policy
# denies. Configure the helper unconditionally instead: Chromium still prefers the namespace
# sandbox where it is genuinely available, and falls back to this helper where it is not.
# Shipping --no-sandbox would also stop the crash, but at the cost of a real security
# boundary for every user — and this app's whole job is holding a private diary.
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" || true
  chmod 4755 "$SANDBOX" || true
fi

# Refresh the desktop database so the .desktop entry is picked up without a re-login.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi

exit 0
