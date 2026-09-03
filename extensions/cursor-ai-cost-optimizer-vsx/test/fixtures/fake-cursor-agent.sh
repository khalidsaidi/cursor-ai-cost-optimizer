#!/usr/bin/env bash
exec node "$(dirname "$0")/fake-cursor-agent.js" "$@"
