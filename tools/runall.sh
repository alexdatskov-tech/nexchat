#!/bin/bash
# Runs the remaining node harnesses (need jsdom / pgsql-parser on the module path).
cd "$(dirname "$0")"
pass=0; fail=0
for t in test-sql test-drive-share test-drive-sharing-sql test-storage-groups test-livecall; do
  if node $t.js >/tmp/nx-$t.out 2>&1; then echo "PASS  $t"; pass=$((pass+1)); else echo "FAIL  $t"; fail=$((fail+1)); tail -5 /tmp/nx-$t.out; fi
done
echo "---- $pass passed, $fail failed"
