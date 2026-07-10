#!/bin/sh
exec hive event turn-end --agent orchestrator --port 4483 --payload "$1"
