#!/bin/bash
# Convert PDF to PNG images for EOG parsing
# Usage: pdf_to_images.sh <input.pdf> [output_dir]

set -e

PDF_FILE="$1"
OUTPUT_DIR="${2:-.}"

if [ -z "$PDF_FILE" ]; then
    echo "Usage: $0 <input.pdf> [output_dir]"
    exit 1
fi

if [ ! -f "$PDF_FILE" ]; then
    echo "Error: File not found: $PDF_FILE"
    exit 1
fi

BASENAME=$(basename "$PDF_FILE" .pdf)
mkdir -p "$OUTPUT_DIR"

echo "Converting $PDF_FILE to PNG images..."
pdftoppm -png -r 150 "$PDF_FILE" "$OUTPUT_DIR/${BASENAME}_page"

# List generated files
echo "Generated images:"
ls -1 "$OUTPUT_DIR/${BASENAME}_page"*.png 2>/dev/null | sort -V

# Count pages
COUNT=$(ls -1 "$OUTPUT_DIR/${BASENAME}_page"*.png 2>/dev/null | wc -l)
echo "Total pages: $COUNT"
echo "Data pages (skip 1-2): pages 3-$COUNT"
