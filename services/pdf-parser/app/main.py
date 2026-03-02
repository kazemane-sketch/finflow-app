from __future__ import annotations

import base64
import io
import os
import re
from datetime import datetime
from typing import Any

import pdfplumber
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from pypdf import PdfReader

app = FastAPI(title="FinFlow PDF Parser", version="0.2.0")

DATE_RE = re.compile(r"\b(\d{2}/\d{2}/\d{4})\b")
AMOUNT_RE = re.compile(r"^\(?-?\d+(?:\.\d{3})*,\d{2}\)?$")
AMOUNT_IN_TEXT_RE = re.compile(r"\(?-?\d+(?:\.\d{3})*,\d{2}\)?")
SPACES_RE = re.compile(r"\s+")

SUMMARY_KEYWORDS = (
    "saldo finale",
    "saldo iniziale",
    "riporti",
    "totale",
    "tot.",
    "movimenti con data contabile",
)

GENERIC_COUNTERPARTY = {
    "n.d.",
    "nd",
    "n/d",
    "pagamenti diversi",
    "altro",
    "saldo finale",
}

COUNTERPARTY_TECH_TOKENS = {
    "(PER",
    "PER",
    "ORDINE",
    "E",
    "CONTO",
    "ORDINE E CONTO",
    "N.D.",
    "N.D",
    "ND",
    "BONIFICO",
    "FILIALE",
    "BIC",
    "INF",
    "RI",
    "RIF",
    "NUM",
    "TOT",
    "IMPORTO",
    "COMMISSIONI",
    "ORD.ORIG",
}

COUNTERPARTY_LINE_STOPWORDS = (
    "FILIALE DISPONENTE",
    "BONIFICO PER ORDINE/CONTO",
    "BONIFICO PER",
    "ID FLUSSO CBI",
    "BIC:",
    "INF:",
    "RI:",
    "RIF.",
    "NUM.",
    "TOT.",
    "IMPORTO",
    "ORD.ORIG",
    "CAUS:",
)

LEGAL_ENTITY_SUFFIXES = {
    "SRL",
    "SRLS",
    "SPA",
    "SAS",
    "SNC",
    "SAPA",
    "SCARL",
    "COOP",
    "CONSORZIO",
    "ASSOCIAZIONE",
    "FONDAZIONE",
}


class ExtractRequest(BaseModel):
    pdfBase64: str = Field(..., min_length=8)
    startPage: int | None = Field(default=None, ge=1)
    endPage: int | None = Field(default=None, ge=1)


def require_internal_token(x_internal_token: str | None) -> None:
    expected = os.getenv("PARSER_INTERNAL_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="PARSER_INTERNAL_TOKEN non configurato")
    if not x_internal_token or x_internal_token != expected:
        raise HTTPException(status_code=401, detail="Invalid internal token")


def normalize_space(value: str) -> str:
    return SPACES_RE.sub(" ", value.replace("\n", " ").replace("\r", " ")).strip()


def normalize_multiline(lines: list[str]) -> str:
    cleaned = [normalize_space(line) for line in lines]
    return "\n".join([line for line in cleaned if line])


def parse_amount_token(token: str) -> float | None:
    t = token.strip().replace("€", "").replace(" ", "")
    if not AMOUNT_RE.match(t):
        return None
    neg = t.startswith("-") or (t.startswith("(") and t.endswith(")"))
    t = t.strip("()-")
    try:
        value = float(t.replace(".", "").replace(",", "."))
    except ValueError:
        return None
    return -value if neg else value


def parse_amount_in_text(text: str) -> tuple[float | None, str | None]:
    for match in AMOUNT_IN_TEXT_RE.finditer(text):
        token = match.group(0)
        value = parse_amount_token(token)
        if value is not None:
            return abs(value), token
    return None, None


def parse_date(text: str) -> str | None:
    try:
        datetime.strptime(text, "%d/%m/%Y")
    except ValueError:
        return None
    return text


def line_bbox(line: dict[str, Any]) -> list[float]:
    return [
        float(line.get("x0", 0.0)),
        float(line.get("top", 0.0)),
        float(line.get("x1", 0.0)),
        float(line.get("bottom", 0.0)),
    ]


def merge_bbox(a: list[float], b: list[float]) -> list[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def extract_reference(text: str) -> str | None:
    patterns = [
        r"\bRIF\.OP\.\s*([A-Z0-9/\-]{5,})",
        r"\bRIF\.\s*([A-Z0-9/\-]{5,})",
        r"\bTRN\s*[:\-]?\s*([A-Z0-9/\-]{6,})",
        r"\bCRO\s*[:\-]?\s*([A-Z0-9/\-]{6,})",
        r"\bID\s+FLUSSO\s+CBI\s*[:\-]?\s*([A-Z0-9/\-]{6,})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None


def extract_category_code(line_text: str) -> str | None:
    match = re.search(r"\b(?:CS\.?\s*)?(\d{1,3})\b", line_text)
    if not match:
        return None
    return match.group(1)


def infer_transaction_type(text: str, direction_base: str) -> str:
    t = normalize_space(text).lower()
    if "f24" in t:
        return "f24"
    if "stipend" in t:
        return "stipendio"
    if "rid" in t or "sdd" in t:
        return "sdd"
    if "preliev" in t:
        return "prelievo"
    if "commission" in t:
        return "commissione"
    if "riba" in t or "effetti ritirati" in t:
        return "riba"
    if "bonific" in t or "disposizione" in t:
        return "bonifico_in" if direction_base == "in" else "bonifico_out"
    return "altro"


def clean_counterparty_name(raw: str | None) -> str | None:
    if not raw:
        return None

    value = raw.strip().strip("-:;,. ")
    value = re.sub(r"^\(\s*PER\b", "", value, flags=re.IGNORECASE).strip(" )")
    value = re.sub(r"^\(?\s*ORDINE\s+E\s+CONTO\)?", "", value, flags=re.IGNORECASE).strip(" )")
    value = re.sub(r"^\s*A\s+FAVORE\s+DI\s+", "", value, flags=re.IGNORECASE).strip()
    value = re.sub(r"^\s*BONIFICO\s+A\s+VOSTRO\s+FAVORE\s*", "", value, flags=re.IGNORECASE).strip()
    value = re.sub(r"\s+", " ", value)
    if not value:
        return None

    for marker in COUNTERPARTY_LINE_STOPWORDS:
        idx = value.upper().find(marker)
        if idx > 0:
            value = value[:idx].strip(" -:;,.")
            break

    value_lower = value.lower().strip()
    if not value_lower or value_lower in GENERIC_COUNTERPARTY:
        return None

    # Reject obvious technical placeholders and fragments like "(PER".
    token_only = re.sub(r"[^A-Z0-9 ]", "", value.upper()).strip()
    if token_only in COUNTERPARTY_TECH_TOKENS:
        return None
    if len(token_only.split()) <= 2 and all(part in COUNTERPARTY_TECH_TOKENS for part in token_only.split()):
        return None

    if len(value) < 3 or len(value) > 120:
        return None
    return value


def _counterparty_result(name: str, source: str, confidence: float) -> dict[str, Any]:
    return {
        "name": name,
        "source": source,
        "confidence": round(max(0.0, min(1.0, confidence)), 2),
    }


def normalize_entity_token(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def is_suffix_only_line(text: str) -> bool:
    token = normalize_entity_token(text)
    return token in LEGAL_ENTITY_SUFFIXES


def looks_company_line(text: str) -> bool:
    cleaned = normalize_space(text)
    if not cleaned:
        return False
    upper = cleaned.upper()
    if any(marker in upper for marker in COUNTERPARTY_LINE_STOPWORDS):
        return False

    digits = sum(1 for ch in upper if ch.isdigit())
    if digits > max(2, int(len(upper) * 0.22)):
        return False

    parts = [p for p in re.split(r"\s+", upper) if p]
    if not parts:
        return False

    if len(parts) == 1:
        return is_suffix_only_line(parts[0])

    has_suffix = any(normalize_entity_token(part) in LEGAL_ENTITY_SUFFIXES for part in parts)
    has_letters = sum(1 for p in parts if any(ch.isalpha() for ch in p))
    return has_letters >= 2 or has_suffix


def extract_counterparty(raw_lines: list[str], raw_text: str) -> dict[str, Any]:
    lines = [normalize_space(x) for x in raw_lines if normalize_space(x)]
    compact = normalize_space(raw_text)

    multiline_patterns = [
        r"BONIFICO\s+A\s+VOSTRO\s+FAVORE(?:\s*\(PER)?(?:\s+ORDINE\s+E\s+CONTO\)?)?\s+([A-Z0-9À-ÿ .,'&/-]{3,220})",
        r"A\s+FAVORE\s+DI\s+([A-Z0-9À-ÿ .,'&/-]{3,220})",
    ]
    for pattern in multiline_patterns:
        match = re.search(pattern, compact, flags=re.IGNORECASE)
        if not match:
            continue
        candidate = clean_counterparty_name(match.group(1))
        if candidate:
            return _counterparty_result(candidate, "regex", 0.92)

    marker_patterns = [
        r"\bCRED\s*:\s*(.+)",
        r"\bBEN\s*:\s*(.+)",
        r"\bORDINANTE\s*:\s*(.+)",
        r"\bBENEFICIARIO\s*:\s*(.+)",
    ]
    for idx, line in enumerate(lines):
        for pattern in marker_patterns:
            match = re.search(pattern, line, flags=re.IGNORECASE)
            if not match:
                continue
            candidate = clean_counterparty_name(match.group(1))
            if candidate:
                return _counterparty_result(candidate, "regex", 0.9)
            if idx + 1 < len(lines):
                next_candidate = clean_counterparty_name(lines[idx + 1])
                if next_candidate:
                    return _counterparty_result(next_candidate, "regex", 0.86)

    for idx, line in enumerate(lines):
        if not looks_company_line(line):
            continue
        candidate = clean_counterparty_name(line)
        if not candidate:
            continue

        merged = candidate
        if idx + 1 < len(lines):
            next_line = clean_counterparty_name(lines[idx + 1])
            if next_line and is_suffix_only_line(next_line):
                merged = clean_counterparty_name(f"{candidate} {next_line}") or merged

        if merged and merged.upper() not in COUNTERPARTY_TECH_TOKENS:
            return _counterparty_result(merged, "heuristic", 0.75)

    return _counterparty_result("N.D.", "unknown", 0.0)


def is_summary_text(text: str) -> bool:
    t = normalize_space(text).lower()
    return any(k in t for k in SUMMARY_KEYWORDS)


def build_lines(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not words:
        return []

    sorted_words = sorted(
        words,
        key=lambda w: (
            round(float(w.get("top", 0.0)), 1),
            float(w.get("x0", 0.0)),
        ),
    )

    lines: list[dict[str, Any]] = []
    for word in sorted_words:
        top = float(word.get("top", 0.0))
        bottom = float(word.get("bottom", top))
        x0 = float(word.get("x0", 0.0))
        x1 = float(word.get("x1", x0))

        if not lines or abs(lines[-1]["top"] - top) > 2.2:
            lines.append(
                {
                    "top": top,
                    "bottom": bottom,
                    "x0": x0,
                    "x1": x1,
                    "words": [word],
                }
            )
            continue

        last = lines[-1]
        last["bottom"] = max(last["bottom"], bottom)
        last["x0"] = min(last["x0"], x0)
        last["x1"] = max(last["x1"], x1)
        last["words"].append(word)

    for line in lines:
        ordered = sorted(line["words"], key=lambda w: float(w.get("x0", 0.0)))
        line["words"] = ordered
        line["text"] = normalize_space(" ".join(str(w.get("text", "")) for w in ordered))

    return lines


def detect_column_split(
    page: pdfplumber.page.Page,
    lines: list[dict[str, Any]],
) -> dict[str, Any]:
    explicit_dare_x = None
    explicit_avere_x = None

    for line in lines:
        text_upper = line["text"].upper()
        if "DARE" in text_upper and explicit_dare_x is None:
            for w in line["words"]:
                if str(w.get("text", "")).upper().startswith("DARE"):
                    explicit_dare_x = (float(w.get("x0", 0.0)) + float(w.get("x1", 0.0))) / 2
                    break
        if "AVERE" in text_upper and explicit_avere_x is None:
            for w in line["words"]:
                if str(w.get("text", "")).upper().startswith("AVERE"):
                    explicit_avere_x = (float(w.get("x0", 0.0)) + float(w.get("x1", 0.0))) / 2
                    break

    if explicit_dare_x and explicit_avere_x and explicit_dare_x < explicit_avere_x:
        return {
            "split_x": (explicit_dare_x + explicit_avere_x) / 2,
            "confidence": 0.99,
            "source": "header",
        }

    centers: list[float] = []
    for line in lines:
        if not DATE_RE.search(line["text"]):
            continue
        for word in line["words"]:
            value = parse_amount_token(str(word.get("text", "")))
            if value is None:
                continue
            centers.append((float(word.get("x0", 0.0)) + float(word.get("x1", 0.0))) / 2)

    if len(centers) >= 2:
        centers.sort()
        median_idx = len(centers) // 2
        split_x = centers[median_idx]
        return {
            "split_x": split_x,
            "confidence": 0.85,
            "source": "amount_centers",
        }

    return {
        "split_x": page.width * 0.70,
        "confidence": 0.55,
        "source": "fallback_page_width",
    }


def parse_pdf_transactions(
    pdf_bytes: bytes,
    start_page: int,
    end_page: int,
) -> dict[str, Any]:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    total_pages = len(reader.pages)
    if total_pages == 0:
        return {
            "transactions": [],
            "summary_rows": [],
            "statement": {
                "opening_balance": None,
                "closing_balance": None,
                "closing_date": None,
            },
            "stats": {
                "pages_processed": 0,
                "rows_detected": 0,
                "rows_unknown_side": 0,
                "parse_errors": 1,
                "summary_rows_detected": 0,
            },
            "quality": {
                "qc_fail_count": 1,
                "ledger_match": None,
                "opening_balance": None,
                "closing_balance": None,
                "computed_closing_balance": None,
                "anomalies": [{"type": "empty_pdf"}],
            },
        }

    start = max(1, start_page)
    end = min(total_pages, end_page)
    if end < start:
        raise ValueError("Range pagine non valido")

    doc_text = "\n".join((reader.pages[i].extract_text() or "") for i in range(start - 1, end))

    opening_balance = None
    closing_balance = None
    for pattern in (
        r"SALDO\s+(?:CONTABILE\s+)?INIZIALE[^0-9\-]*([0-9\.\,]+)",
        r"SALDO\s+INIZIALE[^0-9\-]*([0-9\.\,]+)",
    ):
        match = re.search(pattern, doc_text, flags=re.IGNORECASE)
        if match:
            opening_balance = parse_amount_token(match.group(1))
            if opening_balance is not None:
                opening_balance = abs(opening_balance)
                break

    for pattern in (
        r"SALDO\s+(?:CONTABILE\s+)?FINALE[^0-9\-]*([0-9\.\,]+)",
        r"SALDO\s+FINALE[^0-9\-]*([0-9\.\,]+)",
    ):
        match = re.search(pattern, doc_text, flags=re.IGNORECASE)
        if match:
            closing_balance = parse_amount_token(match.group(1))
            if closing_balance is not None:
                closing_balance = abs(closing_balance)
                break

    anomalies: list[dict[str, Any]] = []
    parse_errors = 0
    transactions: list[dict[str, Any]] = []
    summary_rows: list[dict[str, Any]] = []
    detected_closing_date: str | None = None

    current_row: dict[str, Any] | None = None

    def finalize_current_row() -> None:
        nonlocal current_row, parse_errors, detected_closing_date
        if not current_row:
            return

        raw_lines = current_row.pop("raw_lines", [])
        raw_text_multiline = normalize_multiline(raw_lines)
        raw_text_flat = normalize_space(raw_text_multiline)
        current_row["raw_text"] = raw_text_multiline

        if not current_row.get("description"):
            current_row["description"] = normalize_space(raw_lines[0]) if raw_lines else raw_text_flat[:300]

        current_row["reference"] = current_row.get("reference") or extract_reference(raw_text_flat)
        current_row["category_code"] = current_row.get("category_code") or extract_category_code(raw_text_flat)

        posting_side = current_row.get("posting_side", "unknown")
        current_row["direction_base"] = "out" if posting_side == "dare" else (
            "in" if posting_side == "avere" else "unknown"
        )
        current_row["transaction_type"] = infer_transaction_type(raw_text_flat, current_row["direction_base"])
        counterparty = extract_counterparty(raw_lines, raw_text_flat)
        current_row["counterparty_name"] = counterparty["name"]
        current_row["counterparty_source"] = counterparty["source"]
        current_row["counterparty_confidence"] = counterparty["confidence"]

        row_kind = current_row.get("row_kind", "transaction")
        if row_kind == "summary":
            reason = current_row.get("row_reason") or "summary_row_detected"
            current_row["row_reason"] = reason
            summary_rows.append(current_row)

            if detected_closing_date is None and "saldo finale" in raw_text_flat.lower() and current_row.get("date"):
                detected_closing_date = current_row["date"]

            current_row = None
            return

        needs_review = bool(
            current_row.get("posting_side") == "unknown"
            or float(current_row.get("column_confidence", 0.0)) < 0.80
            or current_row.get("amount_abs") is None
            or not current_row.get("date")
        )
        current_row["qc_needs_review"] = needs_review

        if not current_row.get("date") or current_row.get("amount_abs") is None:
            parse_errors += 1
            anomalies.append(
                {
                    "type": "invalid_transaction_row",
                    "page": current_row.get("page"),
                    "description": current_row.get("description", "")[:120],
                }
            )
            current_row = None
            return

        if current_row.get("posting_side") == "unknown":
            anomalies.append(
                {
                    "type": "unknown_side",
                    "page": current_row.get("page"),
                    "date": current_row.get("date"),
                    "description": current_row.get("description", "")[:120],
                }
            )

        transactions.append(current_row)
        current_row = None

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page_idx in range(start - 1, end):
            page = pdf.pages[page_idx]
            page_no = page_idx + 1

            words = page.extract_words(
                x_tolerance=2,
                y_tolerance=2,
                keep_blank_chars=False,
                use_text_flow=True,
            )
            lines = build_lines(words)
            column_model = detect_column_split(page, lines)
            split_x = float(column_model["split_x"])

            for line in lines:
                text = line["text"]
                if not text:
                    continue

                dates = DATE_RE.findall(text)
                has_date = len(dates) > 0
                summary_text = is_summary_text(text)

                amount_candidates: list[dict[str, Any]] = []
                for w in line["words"]:
                    token = str(w.get("text", "")).strip()
                    value = parse_amount_token(token)
                    if value is None:
                        continue
                    amount_candidates.append(
                        {
                            "text": token,
                            "value": value,
                            "xcenter": (float(w.get("x0", 0.0)) + float(w.get("x1", 0.0))) / 2,
                        }
                    )

                dare_candidates = [a for a in amount_candidates if a["xcenter"] <= split_x]
                avere_candidates = [a for a in amount_candidates if a["xcenter"] > split_x]

                fallback_amount, fallback_text = parse_amount_in_text(text)
                has_amount = len(amount_candidates) > 0 or fallback_amount is not None
                row_kind = "summary" if (summary_text or (len(dare_candidates) > 0 and len(avere_candidates) > 0)) else "transaction"
                start_row = (has_date and has_amount) or (row_kind == "summary" and has_amount)

                if start_row:
                    finalize_current_row()

                    valid_date = parse_date(dates[0]) if dates else None
                    value_date = parse_date(dates[1]) if len(dates) > 1 else None

                    posting_side = "unknown"
                    selected_amount = None
                    row_reason = None

                    if len(dare_candidates) > 0 and len(avere_candidates) == 0:
                        posting_side = "dare"
                        selected_amount = sorted(dare_candidates, key=lambda a: a["xcenter"])[-1]
                    elif len(avere_candidates) > 0 and len(dare_candidates) == 0:
                        posting_side = "avere"
                        selected_amount = sorted(avere_candidates, key=lambda a: a["xcenter"])[0]
                    elif len(dare_candidates) > 0 and len(avere_candidates) > 0:
                        posting_side = "unknown"
                        selected_amount = sorted(amount_candidates, key=lambda a: a["xcenter"])[-1]
                        row_kind = "summary"
                        row_reason = "both_dare_avere"
                    elif amount_candidates:
                        selected_amount = sorted(amount_candidates, key=lambda a: a["xcenter"])[-1]

                    amount_abs = abs(float(selected_amount["value"])) if selected_amount else None
                    amount_text = str(selected_amount["text"]) if selected_amount else None

                    if amount_abs is None and fallback_amount is not None:
                        amount_abs = fallback_amount
                        amount_text = amount_text or fallback_text

                    if row_kind == "transaction" and (valid_date is None or amount_abs is None):
                        parse_errors += 1
                        anomalies.append(
                            {
                                "type": "parse_error_transaction_candidate",
                                "page": page_no,
                                "line": text[:180],
                            }
                        )
                        continue

                    description = text
                    for d in dates[:2]:
                        description = description.replace(d, "", 1)
                    if amount_text:
                        description = description.replace(amount_text, "", 1)
                    description = normalize_space(description)

                    category_code = extract_category_code(description)
                    if category_code:
                        description = re.sub(rf"^\s*{re.escape(category_code)}\s*", "", description).strip()

                    if row_kind == "summary" and row_reason is None:
                        row_reason = "summary_keyword" if summary_text else "aggregated_row"

                    current_row = {
                        "row_kind": row_kind,
                        "row_reason": row_reason,
                        "date": valid_date,
                        "value_date": value_date,
                        "amount_abs": amount_abs,
                        "amount_text": amount_text,
                        "posting_side": posting_side,
                        "description": description,
                        "raw_text": "",
                        "reference": extract_reference(text),
                        "category_code": category_code,
                        "page": page_no,
                        "bbox": line_bbox(line),
                        "column_confidence": float(column_model["confidence"]) if posting_side != "unknown" else 0.40,
                        "column_source": column_model["source"],
                        "raw_lines": [text],
                    }
                    continue

                if current_row is not None:
                    current_row["raw_lines"].append(text)
                    current_row["bbox"] = merge_bbox(current_row["bbox"], line_bbox(line))

        finalize_current_row()

    # Dedup diagnostic only on transactions.
    seen: set[str] = set()
    for tx in transactions:
        key = "|".join(
            [
                str(tx.get("date") or ""),
                str(tx.get("value_date") or ""),
                f"{float(tx.get('amount_abs') or 0):.2f}",
                str(tx.get("posting_side") or ""),
                normalize_space(str(tx.get("reference") or "")).lower(),
                normalize_space(str(tx.get("description") or "")).lower(),
            ]
        )
        if key in seen:
            anomalies.append(
                {
                    "type": "duplicate",
                    "page": tx.get("page"),
                    "date": tx.get("date"),
                    "amount_abs": tx.get("amount_abs"),
                    "reference": tx.get("reference"),
                }
            )
            tx["qc_needs_review"] = True
        else:
            seen.add(key)

    sum_in = sum(float(tx.get("amount_abs") or 0) for tx in transactions if tx.get("posting_side") == "avere")
    sum_out = sum(float(tx.get("amount_abs") or 0) for tx in transactions if tx.get("posting_side") == "dare")

    ledger_match = None
    computed_closing = None
    if opening_balance is not None and closing_balance is not None:
        computed_closing = round(opening_balance + sum_in - sum_out, 2)
        ledger_match = abs(computed_closing - closing_balance) <= 0.02
        if not ledger_match:
            anomalies.append(
                {
                    "type": "ledger_mismatch",
                    "opening_balance": opening_balance,
                    "closing_balance": closing_balance,
                    "computed_closing_balance": computed_closing,
                    "delta": round(computed_closing - closing_balance, 2),
                }
            )

    rows_unknown_side = sum(1 for tx in transactions if tx.get("posting_side") == "unknown")

    stats = {
        "pages_processed": end - start + 1,
        "rows_detected": len(transactions),
        "rows_unknown_side": rows_unknown_side,
        "parse_errors": parse_errors,
        "summary_rows_detected": len(summary_rows),
    }

    quality = {
        "qc_fail_count": len(anomalies),
        "ledger_match": ledger_match,
        "opening_balance": opening_balance,
        "closing_balance": closing_balance,
        "computed_closing_balance": computed_closing,
        "anomalies": anomalies,
        "sum_in": round(sum_in, 2),
        "sum_out": round(sum_out, 2),
    }

    statement = {
        "opening_balance": opening_balance,
        "closing_balance": closing_balance,
        "closing_date": detected_closing_date,
    }

    return {
        "transactions": transactions,
        "summary_rows": summary_rows,
        "statement": statement,
        "stats": stats,
        "quality": quality,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": "pdf-parser", "version": app.version}


@app.post("/extract-mps")
def extract_mps(
    payload: ExtractRequest,
    x_internal_token: str | None = Header(default=None, alias="X-Internal-Token"),
) -> dict[str, Any]:
    require_internal_token(x_internal_token)

    try:
        pdf_bytes = base64.b64decode(payload.pdfBase64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Base64 non valido: {exc}") from exc

    if not pdf_bytes.startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="No PDF header found")

    try:
        total_pages = len(PdfReader(io.BytesIO(pdf_bytes)).pages)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"PDF non leggibile: {exc}") from exc

    start_page = payload.startPage or 1
    end_page = payload.endPage or total_pages

    if start_page < 1:
        start_page = 1
    if end_page > total_pages:
        end_page = total_pages
    if end_page < start_page:
        raise HTTPException(status_code=400, detail="startPage/endPage non validi")

    try:
        result = parse_pdf_transactions(pdf_bytes, start_page, end_page)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Errore parser: {exc}") from exc

    return {
        "transactions": result["transactions"],
        "summary_rows": result["summary_rows"],
        "statement": result["statement"],
        "stats": result["stats"],
        "quality": result["quality"],
        "range": {
            "start_page": start_page,
            "end_page": end_page,
            "total_pages": total_pages,
        },
    }
