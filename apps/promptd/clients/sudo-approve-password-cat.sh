#!/usr/bin/env bash
# Askpass program for the promptd approve flow.
#
# promptd writes the approved password to a 0600 temp file and returns only
# its path; the request that needs it passes the path through
# SUDO_APPROVE_PASSWORD_FILE and points SUDO_ASKPASS at this script. The
# password therefore never enters the requesting process — it flows temp
# file -> this script -> sudo.
exec cat "${SUDO_APPROVE_PASSWORD_FILE:?SUDO_APPROVE_PASSWORD_FILE not set}"
