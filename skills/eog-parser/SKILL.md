---
name: eog-parser
description: Parse EOG Resources revenue check PDFs into CSV format. Trigger on "EOG_parse" with an attached PDF. Converts PDF to images and uses vision to extract tabular data.
---

# EOG Revenue Check Parser

Parse EOG Resources revenue check detail PDFs into structured CSV.

## Workflow

1. Copy attached PDF to working directory
2. Convert PDF pages to PNG images: `pdftoppm -png -r 150 <pdf> eog_page`
3. Skip pages 1-2 (cover/address pages)
4. For each data page (3+), use the `image` tool with the parsing prompt below
5. Compile all extracted rows into a single CSV
6. Save to `<original_name>_parsed.csv`

## CSV Format

```csv
Check No.,Owner No.,Check Date,Well Name,Property Code,Deck,State-County,Int. Type,Owner Int,Settlement Int,,,,Prod Date,Prod Type,Quantity BBLS/MCF,Value,Tax,Tax Code,Other Deducts,Deduct Code,Net Value,Price,Gross Value,Tax,Other Deducts,Net Value
```

**Header row structure:**
- Columns 1-10: Check/Property info (Check No., Owner No., Check Date, Well Name, Property Code, Deck, State-County, Int. Type, Owner Int, Settlement Int)
- Columns 11-13: Empty spacers
- Columns 14-20: Gross section (Prod Date, Prod Type, Quantity, Value, Tax, Tax Code, Other Deducts, Deduct Code, Net Value, Price)
- Columns 21-24: Owner section (Gross Value, Tax, Other Deducts, Net Value)

**Data rows:**
- First row for each property/deck: Fill Check No., Owner No., Check Date, Well Name, Property Code, Deck, State-County, Int. Type, Owner Int, Settlement Int
- Continuation rows: Leave columns 1-10 empty, fill production details only
- Property Total rows: Mark with "Property Total" in appropriate column

## Vision Parsing Prompt

Use this prompt for each page image:

```
Extract ALL data rows from this EOG Resources revenue check detail page.

Output CSV rows (no header) with these columns:
Check_No,Owner_No,Check_Date,Well_Name,Property_Code,Deck,State_County,Int_Type,Owner_Int,Settlement_Int,,,Prod_Date,Prod_Type,Quantity,Value,Tax,Tax_Code,Other_Deducts,Deduct_Code,Net_Value,Price,Owner_Gross,Owner_Tax,Owner_Other,Owner_Net

Rules:
- Check No: 10-digit number (e.g., 0006602040)
- Owner No: 6-digit number (e.g., 425039)
- Check Date: MM/DD/YYYY format
- Well Name: e.g., "JOSEPH UNIT # 1H" or "SULCATA A # 2H"
- Property Code: Format XXXXXX-XXX (e.g., 068715-000)
- Deck: 1B, 1E, 15, 16, S1, S2, U1, etc.
- Int Type: Usually 2
- Owner Int / Settlement Int: Decimal like 0.00406607
- Prod Date: MM/YY format
- Prod Type: 10=Oil, 22=Gas, 32=NGL, 41=Severance, 70=Prior Period
- Tax Code: CU or SV
- Deduct Code: TP or TR (if present)
- Preserve negative numbers with minus sign
- Preserve all decimal places

For each property section, note the Well Name, Property Code, Deck from the header.
Fill those values on the first row of each section, leave blank on continuation rows.
```

## Example Output

```csv
0006602040,425039,7/11/2025,JOSEPH UNIT # 1H,068715-000,1B,TX-KARNES,2,0.00406607,0.00406607,,,,05/25,10,117.84,7032.74,0.74,CU,,,7032.00,63.28,30.32,,1.32,30.32
,,,,,,,,,,,,,05/25,10,,,323.51,SV,,,-323.51,,,,,-1.32
,,,,,,,,,,,,,05/25,32,2.30,109.57,5.04,SV,,,104.53,63.22,0.59,0.02,,0.57
```
