#!/bin/bash
LOG=/home/z/my-project/scripts/bg-remove.log
WORKER=/home/z/my-project/scripts/bg_remove_worker.py
PYTHON=/home/z/.venv/bin/python3
pkill -f bg_remove_worker.py 2>/dev/null
sleep 1
while true; do
  echo "[$(date +%H:%M:%S)] Starting bg-remove worker..." >> "$LOG"
  nice -n 10 "$PYTHON" "$WORKER" >> "$LOG" 2>&1
  echo "[$(date +%H:%M:%S)] Worker exited with code $?, restarting in 2s..." >> "$LOG"
  sleep 2
done
