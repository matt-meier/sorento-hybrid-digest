#!/usr/bin/env python3
"""
Sanitizes and transforms the 2022 Kia Sorento Hybrid Google Sheet export
into a privacy-safe, static data.json payload for GitHub Pages.

Usage:
  Local CSV:  python scripts/build_data.py --csv "2022_Kia_Sorento_S_Hybrid_Sheet1.csv"
  Remote URL: SHEET_CSV_URL="https://docs.google.com/spreadsheets/d/.../export?format=csv" python scripts/build_data.py
"""

import argparse
import io
import json
import os
import re
import urllib.request
from datetime import datetime, timezone
import pandas as pd
import numpy as np


SENSITIVE_PATTERNS = [
    re.compile(r"\bVIN\b", re.IGNORECASE),
    re.compile(r"KNDRG[A-Z0-9]{12}", re.IGNORECASE),
    re.compile(r"payoff on trade", re.IGNORECASE),
    re.compile(r"trade in value", re.IGNORECASE),
    re.compile(r"final balance", re.IGNORECASE),
    re.compile(r"service contract", re.IGNORECASE),
    re.compile(r"gap insurance", re.IGNORECASE),
    re.compile(r"depreciation protection", re.IGNORECASE),
    re.compile(r"title settlement", re.IGNORECASE),
]


def is_sensitive_note(note_val) -> bool:
    if pd.isna(note_val):
        return False
    text = str(note_val)
    return any(pat.search(text) for pat in SENSITIVE_PATTERNS)


def clean_note(note_val):
    if pd.isna(note_val) or is_sensitive_note(note_val):
        return None
    txt = str(note_val).strip()
    return txt if txt else None


def clean_number_series(series: pd.Series) -> pd.Series:
    cleaned = (
        series.astype(str)
        .str.replace(r"[\$,\s]", "", regex=True)
        .replace({"": np.nan, "nan": np.nan, "None": np.nan, "null": np.nan, "--": np.nan, "N/A": np.nan})
    )
    return pd.to_numeric(cleaned, errors="coerce")


def extract_state(row) -> str:
    for field in (row.get("Address"), row.get("Vendor")):
        if pd.notna(field):
            m = re.search(r",\s*([A-Z]{2})\b", str(field))
            if m:
                return m.group(1)
    return "Other"


def extract_city_state(row) -> str:
    vendor = str(row.get("Vendor") or "").strip()
    if " in " in vendor:
        loc = vendor.split(" in ", 1)[1].strip()
        if loc:
            return loc
    addr = str(row.get("Address") or "").strip()
    m = re.search(r"([A-Za-z .'-]+,\s*[A-Z]{2})\b", addr)
    if m:
        return m.group(1).strip()
    st = row.get("State", "Other")
    return st if st != "Other" else "Unknown"


def parse_coords(val):
    if pd.isna(val):
        return None, None
    parts = [p.strip() for p in str(val).split(",")]
    if len(parts) == 2:
        try:
            lat, lon = float(parts[0]), float(parts[1])
            if 18.0 <= lat <= 72.0 and -175.0 <= lon <= -60.0:
                return round(lat, 2), round(lon, 2)
        except ValueError:
            pass
    return None, None


def extract_spark_plug_cost(row):
    if pd.notna(row["Cost"]):
        return float(row["Cost"])
    note = str(row.get("Notes") or "")
    if "Spark plugs:" in note:
        nums = [float(x) for x in re.findall(r"\$([0-9]+(?:\.[0-9]+)?)", note)]
        if nums:
            return round(sum(nums), 2)
    return None


def load_dataframe(csv_path: str | None, csv_url: str | None) -> pd.DataFrame:
    if csv_path and os.path.exists(csv_path):
        return pd.read_csv(csv_path)
    if csv_url:
        req = urllib.request.Request(csv_url, headers={"User-Agent": "SorentoHybridBuilder/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8-sig")
        return pd.read_csv(io.StringIO(raw))
    raise FileNotFoundError("Provide --csv <path> or set SHEET_CSV_URL.")


def transform(df_raw: pd.DataFrame) -> dict:
    df = df_raw.copy()
    df.columns = [c.strip() for c in df.columns]

    # Filter out template / empty rows with no valid Date
    df = df[df["Date"].notna()].copy()
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df[df["Date"].notna()].copy()

    for col in ["Category", "Action", "Vendor", "Address", "Coordinates", "Notes"]:
        if col in df.columns:
            df[col] = df[col].astype(str).str.strip().replace({"nan": np.nan, "None": np.nan, "": np.nan})

    for col in ["Mileage", "Miles Traveled", "Cost", "Gallons", "MPG", "Cost Per Gallon"]:
        if col in df.columns:
            df[col] = clean_number_series(df[col])

    # Drop VIN / purchase contract metadata row (and any row containing sensitive patterns)
    df = df[~df["Notes"].apply(is_sensitive_note)].copy()

    # Standardize typo in Action ("Serpentime Belt" -> "Serpentine Belt")
    df["Action"] = df["Action"].replace({"Serpentime Belt": "Serpentine Belt"})

    # Odometer & ownership span
    start_mileage = float(df["Mileage"].min())
    end_mileage = float(df["Mileage"].max())
    miles_driven = round(end_mileage - start_mileage, 1)

    purchase_rows = df[df["Category"] == "Vehicle Purchase"]
    start_date = purchase_rows["Date"].min() if len(purchase_rows) else df["Date"].min()
    end_date = df["Date"].max()
    days_owned = max(int((end_date - start_date).days), 1)
    years_owned = days_owned / 365.25
    annual_miles = round(miles_driven / years_owned)

    # Category cost totals
    def cat_sum(cat_name: str) -> float:
        return float(df.loc[df["Category"] == cat_name, "Cost"].fillna(0).sum())

    gas_cost = cat_sum("Gas")
    maint_cost = cat_sum("Maintenance")
    ins_cost = cat_sum("Insurance")
    tax_cost = cat_sum("Taxes")
    extra_cost = cat_sum("Extra")
    uncat_cost = float(df.loc[df["Category"].isna(), "Cost"].fillna(0).sum())
    dep_cost = cat_sum("Depreciation")

    operating_total = round(gas_cost + maint_cost + ins_cost + tax_cost + extra_cost + uncat_cost, 2)
    tco_total = round(operating_total + dep_cost, 2)

    operating_cpm = round(operating_total / miles_driven, 4)
    tco_cpm = round(tco_total / miles_driven, 4)

    # Gas fill-ups
    gas = df[df["Category"] == "Gas"].copy().sort_values("Date")
    gas["State"] = gas.apply(extract_state, axis=1)
    gas["CityState"] = gas.apply(extract_city_state, axis=1)
    gas["Brand"] = gas["Vendor"].fillna("Unknown").apply(lambda x: x.split(" in ")[0].strip())
    gas["IsClub"] = gas["Brand"].isin(["Sam's Club Gas Station", "Costco Gas Station"])
    gas["YM"] = gas["Date"].dt.to_period("M").astype(str)
    gas["CalMonth"] = gas["Date"].dt.month

    total_gallons = round(float(gas["Gallons"].fillna(0).sum()), 2)
    true_mpg = round(miles_driven / total_gallons, 2)
    weighted_ppg = round(gas_cost / total_gallons, 3)

    # Nebraska normalization ratio per state (for states with >= 2 fill-ups)
    ne_mask = gas["State"] == "NE"
    ne_ppg = float(gas.loc[ne_mask, "Cost"].sum() / gas.loc[ne_mask, "Gallons"].sum())
    state_stats = {}
    for st, grp in gas.groupby("State"):
        gal_s = float(grp["Gallons"].sum())
        cost_s = float(grp["Cost"].sum())
        state_stats[st] = {
            "count": int(len(grp)),
            "ppg": (cost_s / gal_s) if gal_s > 0 else ne_ppg,
        }

    fillups_out = []
    for _, r in gas.iterrows():
        lat, lon = parse_coords(r.get("Coordinates"))
        st = r["State"]
        ppg = float(r["Cost Per Gallon"]) if pd.notna(r["Cost Per Gallon"]) else None
        if ppg is not None:
            if st == "NE" or state_stats.get(st, {}).get("count", 0) < 2:
                ppg_ne = round(ppg, 3)
            else:
                factor = ne_ppg / state_stats[st]["ppg"]
                ppg_ne = round(ppg * factor, 3)
        else:
            ppg_ne = None

        fillups_out.append({
            "date": r["Date"].strftime("%Y-%m-%d"),
            "ym": r["YM"],
            "cal_month": int(r["CalMonth"]),
            "mileage": int(r["Mileage"]) if pd.notna(r["Mileage"]) else None,
            "miles_traveled": round(float(r["Miles Traveled"]), 1) if pd.notna(r["Miles Traveled"]) else None,
            "brand": r["Brand"],
            "city_state": r["CityState"],
            "state": st,
            "is_club": bool(r["IsClub"]),
            "cost": round(float(r["Cost"]), 2) if pd.notna(r["Cost"]) else None,
            "gallons": round(float(r["Gallons"]), 3) if pd.notna(r["Gallons"]) else None,
            "ppg": round(ppg, 3) if ppg is not None else None,
            "ppg_ne": ppg_ne,
            "lat": lat,
            "lon": lon,
        })

    # Monthly gas series
    monthly_out = []
    for ym, grp in gas.groupby("YM"):
        gal_m = float(grp["Gallons"].sum())
        cost_m = float(grp["Cost"].sum())
        miles_m = float(grp["Miles Traveled"].fillna(0).sum())
        cost_ne_m = sum(
            (x["ppg_ne"] * x["gallons"])
            for x in fillups_out
            if x["ym"] == ym and x["ppg_ne"] is not None and x["gallons"] is not None
        )
        monthly_out.append({
            "ym": ym,
            "fills": int(len(grp)),
            "cost": round(cost_m, 2),
            "gallons": round(gal_m, 2),
            "miles": round(miles_m, 1),
            "ppg": round(cost_m / gal_m, 3) if gal_m > 0 else None,
            "ppg_ne": round(cost_ne_m / gal_m, 3) if gal_m > 0 else None,
            "true_mpg": round(miles_m / gal_m, 2) if gal_m > 0 else None,
        })

    # Seasonal calendar month efficiency (1..12)
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    seasonal_out = []
    for m_idx in range(1, 13):
        grp = gas[gas["CalMonth"] == m_idx]
        gal_s = float(grp["Gallons"].sum())
        miles_s = float(grp["Miles Traveled"].fillna(0).sum())
        seasonal_out.append({
            "month_num": m_idx,
            "month": month_names[m_idx - 1],
            "fills": int(len(grp)),
            "miles": round(miles_s, 1),
            "gallons": round(gal_s, 2),
            "true_mpg": round(miles_s / gal_s, 2) if gal_s > 0 else None,
        })

    # Warehouse club vs non-club comparison
    club_gal = float(gas.loc[gas["IsClub"], "Gallons"].sum())
    club_cost = float(gas.loc[gas["IsClub"], "Cost"].sum())
    nonclub_gal = float(gas.loc[~gas["IsClub"], "Gallons"].sum())
    nonclub_cost = float(gas.loc[~gas["IsClub"], "Cost"].sum())
    club_ppg = round(club_cost / club_gal, 3) if club_gal > 0 else 0.0
    nonclub_ppg = round(nonclub_cost / nonclub_gal, 3) if nonclub_gal > 0 else 0.0
    club_savings = round((nonclub_ppg - club_ppg) * club_gal, 2)

    # Hybrid vs 26 MPG non-hybrid Sorento comparison
    non_hybrid_epa = 26.0
    non_hybrid_gal = miles_driven / non_hybrid_epa
    gallons_saved = round(non_hybrid_gal - total_gallons, 1)
    hybrid_fuel_savings = round(gallons_saved * weighted_ppg, 2)

    # Maintenance log (sanitized, newest first)
    maint = df[df["Category"] == "Maintenance"].copy().sort_values(["Date", "Mileage"], ascending=[False, False])
    maint_out = []
    for _, r in maint.iterrows():
        cost_val = extract_spark_plug_cost(r)
        vendor_clean = str(r["Vendor"]).strip() if pd.notna(r["Vendor"]) else "Self / Parts"
        maint_out.append({
            "date": r["Date"].strftime("%Y-%m-%d"),
            "mileage": int(r["Mileage"]) if pd.notna(r["Mileage"]) else None,
            "action": str(r["Action"]).strip() if pd.notna(r["Action"]) else "Service",
            "vendor": vendor_clean,
            "cost": round(float(r["Cost"]), 2) if pd.notna(r["Cost"]) else None,
            "est_cost": cost_val,
            "notes": clean_note(r.get("Notes")),
        })

    # Top maintenance action totals
    maint_by_action = (
        maint.groupby("Action")["Cost"]
        .sum()
        .fillna(0)
        .sort_values(ascending=False)
    )
    maint_breakdown = [
        {"action": str(act), "cost": round(float(val), 2)}
        for act, val in maint_by_action.items()
        if val > 0
    ]

    # Top gas brands
    brand_grp = (
        gas.groupby("Brand")
        .agg(fills=("Cost", "count"), spend=("Cost", "sum"), gallons=("Gallons", "sum"))
        .sort_values("fills", ascending=False)
    )
    brands_out = []
    for br, row_b in brand_grp.head(8).iterrows():
        brands_out.append({
            "brand": str(br),
            "fills": int(row_b["fills"]),
            "spend": round(float(row_b["spend"]), 2),
            "gallons": round(float(row_b["gallons"]), 2),
            "ppg": round(float(row_b["spend"] / row_b["gallons"]), 3),
        })

    # State summary
    state_out = []
    for st, grp in gas.groupby("State"):
        state_out.append({
            "state": st,
            "fills": int(len(grp)),
            "spend": round(float(grp["Cost"].sum()), 2),
            "gallons": round(float(grp["Gallons"].sum()), 2),
        })
    state_out.sort(key=lambda x: x["fills"], reverse=True)

    # Milestone projection (150K miles)
    remaining_to_150k = max(0.0, 150000.0 - end_mileage)
    years_to_150k = remaining_to_150k / (miles_driven / years_owned)
    proj_150k_year = int(round(end_date.year + years_to_150k))

    # Last insurance payment date for transparency note
    ins_rows = df[df["Category"] == "Insurance"]
    last_ins_date = ins_rows["Date"].max().strftime("%Y-%m-%d") if len(ins_rows) else None

    payload = {
        "meta": {
            "vehicle": "2022 Kia Sorento S Hybrid",
            "start_date": start_date.strftime("%Y-%m-%d"),
            "end_date": end_date.strftime("%Y-%m-%d"),
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "last_insurance_date": last_ins_date,
        },
        "summary": {
            "start_mileage": int(start_mileage),
            "end_mileage": int(end_mileage),
            "miles_driven": int(miles_driven),
            "annual_miles": int(annual_miles),
            "fillup_count": int(len(gas)),
            "maintenance_count": int(len(maint)),
            "total_gallons": total_gallons,
            "true_mpg": true_mpg,
            "epa_combined_fwd": 37,
            "epa_combined_awd": 35,
            "epa_non_hybrid": 26,
            "weighted_ppg": weighted_ppg,
            "ne_baseline_ppg": round(ne_ppg, 3),
            "total_gas_cost": round(gas_cost, 2),
            "total_maintenance_cost": round(maint_cost, 2),
            "total_insurance_cost": round(ins_cost, 2),
            "total_taxes_cost": round(tax_cost, 2),
            "total_extra_cost": round(extra_cost + uncat_cost, 2),
            "total_depreciation": round(dep_cost, 2),
            "operating_total": operating_total,
            "tco_total": tco_total,
            "operating_cpm": operating_cpm,
            "tco_cpm": tco_cpm,
            "fuel_cpm": round(gas_cost / miles_driven, 4),
            "maintenance_cpm": round(maint_cost / miles_driven, 4),
            "benchmarks": {
                "aaa_medium_suv_2026_cpm": 0.9632,
                "aaa_url": "https://newsroom.aaa.com/auto/your-driving-costs/",
                "irs_h2_2026_cpm": 0.76,
                "irs_url": "https://www.irs.gov/tax-professionals/standard-mileage-rates",
                "epa_url": "https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=44699",
                "nhtsa_url": "https://www.nhtsa.gov/vehicle/2022/KIA/SORENTO%252520HYBRID",
            },
            "hybrid_savings": {
                "gallons_saved": gallons_saved,
                "dollars_saved": hybrid_fuel_savings,
            },
            "club_savings": {
                "club_fills": int(gas["IsClub"].sum()),
                "nonclub_fills": int((~gas["IsClub"]).sum()),
                "club_gallons": round(club_gal, 1),
                "nonclub_gallons": round(nonclub_gal, 1),
                "club_ppg": club_ppg,
                "nonclub_ppg": nonclub_ppg,
                "dollars_saved": club_savings,
            },
            "proj_150k_year": proj_150k_year,
        },
        "monthly_gas": monthly_out,
        "fillups": fillups_out,
        "seasonal_mpg": seasonal_out,
        "states": state_out,
        "top_brands": brands_out,
        "maintenance_log": maint_out,
        "maintenance_breakdown": maint_breakdown,
    }
    return payload


def strict_validate(payload: dict):
    raw = json.dumps(payload, allow_nan=False)
    for pat in SENSITIVE_PATTERNS:
        if pat.search(raw):
            raise ValueError(f"Sensitive pattern leaked into output: {pat.pattern}")
    parsed = json.loads(raw)
    assert isinstance(parsed["fillups"], list) and len(parsed["fillups"]) > 0
    assert isinstance(parsed["maintenance_log"], list) and len(parsed["maintenance_log"]) > 0
    return raw


def main():
    parser = argparse.ArgumentParser(description="Build sanitized data.json for Sorento Hybrid Data App")
    parser.add_argument("--csv", default=None, help="Path to local CSV file")
    parser.out = None
    parser.add_argument("--out", default="data.json", help="Output JSON file path")
    args = parser.parse_args()

    csv_url = os.environ.get("SHEET_CSV_URL")
    df_raw = load_dataframe(args.csv, csv_url)
    payload = transform(df_raw)
    raw_json = strict_validate(payload)

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(raw_json)

    print(
        f"Wrote {args.out} ({len(raw_json):,} bytes): "
        f"{payload['summary']['fillup_count']} fill-ups, "
        f"{payload['summary']['maintenance_count']} maintenance entries, "
        f"{payload['summary']['miles_driven']:,} miles."
    )


if __name__ == "__main__":
    main()
