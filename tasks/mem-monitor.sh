#!/bin/bash
# Log memory usage and check for OOM kills
LOG=/var/log/upend-memory.log
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Log memory stats
MEM=$(free -m | awk "/Mem:/ {printf \"total=%sMB used=%sMB free=%sMB avail=%sMB\", \$2, \$3, \$4, \$7}")
SWAP=$(free -m | awk "/Swap:/ {printf \"total=%sMB used=%sMB\", \$2, \$3}")
echo "$TIMESTAMP mem: $MEM swap: $SWAP" >> $LOG

# Check for OOM kills in the last 60 seconds
OOM=$(dmesg --time-format iso 2>/dev/null | grep -i "out of memory\|oom-kill" | tail -5)
if [ -n "$OOM" ]; then
    echo "$TIMESTAMP OOM DETECTED: $OOM" >> $LOG
fi

# Alert if available memory < 100MB and swap > 50% used
AVAIL=$(free -m | awk "/Mem:/ {print \$7}")
SWAP_USED=$(free -m | awk "/Swap:/ {print \$3}")
SWAP_TOTAL=$(free -m | awk "/Swap:/ {print \$2}")
if [ "$AVAIL" -lt 100 ] && [ "$SWAP_TOTAL" -gt 0 ] && [ "$SWAP_USED" -gt $((SWAP_TOTAL / 2)) ]; then
    echo "$TIMESTAMP CRITICAL: low memory avail=${AVAIL}MB swap_used=${SWAP_USED}MB" >> $LOG
fi

# Keep log from growing forever (last 10000 lines)
tail -10000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG 2>/dev/null
