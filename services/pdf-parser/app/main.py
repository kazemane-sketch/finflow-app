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

app = FastAPI(title="FinFlow PDF Parser", version="0.1.0")

DATE_RE = re.compile(r"\b(\d{2}/\d{2}/\d{4})\b")
AMOUNT_RE = re.compile(r"^\(?-?\d+(?:\.\d{3})*,\d{2}\)?$")
AMOUNT_IN_TEXT_RE = re.compile(r"\(?-?\d+(?:\.\d{3})*,\d{2}\)?")
SPACES_RE = re.compile(r"\s+")

OUT_HINTS = (
    "vostra disposizione a favore",
    "addebito",
    "pagamento",
    "f24",
    "commissioni",
    "commissione",
    "rid",
    "sdd",
    "prelievo",
    "effetti ritirati",
)
IN_HINTS = (
    "a vostro favore",
    "accredito",
    "stipendio",
    "interessi a credito",
    "versamento",
    "incasso",
)


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
    # Nei PDF MPS il codice causale e' spesso vicino all'importo (es. 26, 31, 48)
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


def contains_out_hint(text: str) -> bool:
    t = normalize_space(text).lower()
    return any(h in t for h in OUT_HINTS)


def contains_in_hint(text: str) -> bool:
    t = normalize_space(text).lower()
    return any(h in t for h in IN_HINTS)


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
            "stats": {
                "pages_processed": 0,
                "rows_detected": 0,
                "rows_unknown_side": 0,
                "parse_errors": 1,
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

    current_tx: dict[str, Any] | None = None

    def finalize_current_tx() -> None:
        nonlocal current_tx
        if not current_tx:
            return

        raw_text = normalize_space(" ".join(current_tx.pop("raw_lines", [])))
        current_tx["raw_text"] = raw_text

        if not current_tx.get("description"):
            current_tx["description"] = raw_text[:300]

        current_tx["reference"] = current_tx.get("reference") or extract_reference(raw_text)
        current_tx["category_code"] = current_tx.get("category_code") or extract_category_code(raw_text)
        current_tx["direction_base"] = "out" if current_tx.get("posting_side") == "dare" else (
            "in" if current_tx.get("posting_side") == "avere" else "unknown"
        )
        current_tx["transaction_type"] = infer_transaction_type(raw_text, current_tx["direction_base"])

        needs_review = bool(
            current_tx.get("posting_side") == "unknown"
            or float(current_tx.get("column_confidence", 0.0)) < 0.80
            or current_tx.get("amount_abs") is None
            or not current_tx.get("date")
        )
        current_tx["qc_needs_review"] = needs_review

        if current_tx.get("posting_side") == "unknown":
            anomalies.append(
                {
                    "type": "unknown_side",
                    "page": current_tx.get("page"),
                    "date": current_tx.get("date"),
                    "description": current_tx.get("description", "")[:120],
                }
            )

        if not current_tx.get("date"):
            anomalies.append(
                {
                    "type": "missing_date",
                    "page": current_tx.get("page"),
                    "description": current_tx.get("description", "")[:120],
                }
            )

        if current_tx.get("amount_abs") is None:
            anomalies.append(
                {
                    "type": "amount_parse_failed",
                    "page": current_tx.get("page"),
                    "description": current_tx.get("description", "")[:120],
                }
            )

        transactions.append(current_tx)
        current_tx = None

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
                is_new_tx = len(dates) > 0

                if is_new_tx:
                    finalize_current_tx()

                    valid_date = parse_date(dates[0]) if dates else None
                    value_date = parse_date(dates[1]) if len(dates) > 1 else None

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

                    posting_side = "unknown"
                    selected_amount = None

                    if dare_candidates and not avere_candidates:
                        posting_side = "dare"
                        selected_amount = sorted(dare_candidates, key=lambda a: a["xcenter"])[-1]
                    elif avere_candidates and not dare_candidates:
                        posting_side = "avere"
                        selected_amount = sorted(avere_candidates, key=lambda a: a["xcenter"])[0]
                    elif dare_candidates and avere_candidates:
                        anomalies.append(
                            {
                                "type": "both_columns",
                                "page": page_no,
                                "line": text[:180],
                            }
                        )
                        selected_amount = sorted(amount_candidates, key=lambda a: a["xcenter"])[-1]
                    elif amount_candidates:
                        selected_amount = sorted(amount_candidates, key=lambda a: a["xcenter"])[-1]

                    amount_abs = abs(float(selected_amount["value"])) if selected_amount else None
                    amount_text = str(selected_amount["text"]) if selected_amount else None

                    if amount_abs is None:
                        fallback_amount, fallback_text = parse_amount_in_text(text)
                        amount_abs = fallback_amount
                        amount_text = amount_text or fallback_text

                    if valid_date is None:
                        parse_errors += 1
                    if amount_abs is None:
                        parse_errors += 1

                    description = text
                    for d in dates[:2]:
                        description = description.replace(d, "", 1)
                    if amount_text:
                        description = description.replace(amount_text, "", 1)
                    description = normalize_space(description)

                    category_code = extract_category_code(description)
                    if category_code:
                        description = re.sub(rf"^\s*{re.escape(category_code)}\s*", "", description).strip()

                    current_tx = {
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

                if current_tx is not None:
                    current_tx["raw_lines"].append(text)
                    current_tx["bbox"] = merge_bbox(current_tx["bbox"], line_bbox(line))

        finalize_current_tx()

    # Dedup diagnostic only: flag duplicates but do not drop rows.
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
    parse_errors += len([a for a in anomalies if a.get("type") in ("missing_date", "amount_parse_failed")])

    stats = {
        "pages_processed": end - start + 1,
        "rows_detected": len(transactions),
        "rows_unknown_side": rows_unknown_side,
        "parse_errors": parse_errors,
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

    return {"transactions": transactions, "stats": stats, "quality": quality}


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
        "stats": result["stats"],
        "quality": result["quality"],
        "range": {
            "start_page": start_page,
            "end_page": end_page,
            "total_pages": total_pages,
        },
    }
