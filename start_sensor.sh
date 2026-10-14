#!/bin/zsh
set -e

cd "${0:A:h}"

if [[ ! -d .venv-mqtt ]]; then
  python3 -m venv .venv-mqtt
fi

source .venv-mqtt/bin/activate
python3 -m pip install -r requirements.txt
exec python3 mac_fake_sensor.py
