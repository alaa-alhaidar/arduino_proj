#!/bin/sh
set -eu

MODEL_URL="https://raw.githubusercontent.com/luminous0219/fire-and-smoke-detection-yolov8/c30923f568d915a53fcf85989be9fe5d4e030518/weights/best.pt"
MODEL_SHA256="ac0a10257b2bc1f20c9d957f8adeeb61dd6140322fc19d0b4a116cb491776d16"
MODEL_TARGET="${1:-/home/alaa/pi-control/models/fire-best.pt}"
MODEL_DIRECTORY=$(dirname "$MODEL_TARGET")

mkdir -p "$MODEL_DIRECTORY"
TEMP_MODEL=$(mktemp "$MODEL_DIRECTORY/.fire-best.pt.XXXXXX")
trap 'rm -f "$TEMP_MODEL"' EXIT HUP INT TERM

echo "Lade offenes YOLOv8n-Feuermodell ..."
curl --fail --location --proto '=https' --tlsv1.2 "$MODEL_URL" --output "$TEMP_MODEL"

ACTUAL_SHA256=$(sha256sum "$TEMP_MODEL" | cut -d ' ' -f 1)
if [ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]; then
    echo "Fehler: Prüfsumme der Modelldatei stimmt nicht." >&2
    exit 1
fi

chmod 0644 "$TEMP_MODEL"
mv "$TEMP_MODEL" "$MODEL_TARGET"
trap - EXIT HUP INT TERM
echo "Modell installiert: $MODEL_TARGET"
