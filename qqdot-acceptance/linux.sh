#!/bin/bash
set -euo pipefail
mkdir -p /evidence
cat /etc/os-release > /evidence/os.txt
for x in python python3 pip node npm uv; do
  if command -v "$x"; then echo "Unexpected preinstalled runtime: $x" >&2; exit 1; fi
  echo "$x absent" >> /evidence/baseline.txt
done
dpkg-query -W > /evidence/system-packages-before.txt
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates libegl1 libopengl0 libgl1 libglib2.0-0t64 libxkbcommon0 libdbus-1-3 libnss3 libasound2t64 libxcb-cursor0 fonts-dejavu-core
dpkg-query -W > /evidence/system-packages-after.txt
cp -a /input/Open-QQ-Dot /app
cd /app
date -u +%FT%TZ > /evidence/install-started.txt
set +e
timeout 900 sh start.sh --prepare-only > /evidence/cold-install.log 2>&1
install_code=$?
set -e
echo "$install_code" > /evidence/cold-install-exit.txt
tail -30 /evidence/cold-install.log
if [ "$install_code" -ne 0 ]; then exit "$install_code"; fi
date -u +%FT%TZ > /evidence/install-finished.txt
timeout 120 sh start.sh --prepare-only > /evidence/reuse.log 2>&1
export QT_QPA_PLATFORM=offscreen
.venv/bin/python -X utf8 launcher.py --check > /evidence/startup.json
.venv/bin/python -c 'import json; r=json.load(open("/evidence/startup.json")); assert r["ready"] and r["model_requests"] == 0 and not r["starts_services"]'
.bootstrap/uv pip install --python .venv/bin/python pytest pytest-subtests -r requirements-browser-optional.txt
.venv/bin/python -m playwright install --with-deps chromium
.bootstrap/uv pip list --python .venv/bin/python > /evidence/python-packages.txt
set +e
timeout 2100 .venv/bin/python -X utf8 -m pytest -q tests --junitxml=/evidence/full.xml --basetemp=/tmp/qqdot-tests > /evidence/full.log 2>&1
test_code=$?
set -e
echo "$test_code" > /evidence/test-exit.txt
tail -70 /evidence/full.log
exit "$test_code"
