# PDF Parser Service (Cloud Run)

Servizio Python (`FastAPI`) per estrarre movimenti bancari MPS da PDF machine-generated.

## Endpoint

- `GET /health`
- `POST /extract-mps`

### Auth interna

Ogni chiamata a `POST /extract-mps` richiede header:

- `X-Internal-Token: <token>`

Il valore deve corrispondere alla variabile ambiente `PARSER_INTERNAL_TOKEN`.

## Request `POST /extract-mps`

```json
{
  "pdfBase64": "<base64 pdf>",
  "startPage": 1,
  "endPage": 10
}
```

`startPage`/`endPage` sono opzionali e 1-based (inclusive).

## Response

- `transactions[]` con campi utili a orchestrator/edge:
  - `date`, `value_date`, `amount_abs`, `amount_text`
  - `posting_side` (`dare|avere|unknown`)
  - `description`, `raw_text`, `reference`, `category_code`
  - debug: `page`, `bbox`, `column_confidence`, `column_source`
- `stats`:
  - `pages_processed`, `rows_detected`, `rows_unknown_side`, `parse_errors`
- `quality`:
  - `qc_fail_count`, `ledger_match`, `opening_balance`, `closing_balance`, `computed_closing_balance`, `anomalies[]`

## Run locale

```bash
cd services/pdf-parser
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Deploy Cloud Run

Impostazioni consigliate:

- Root build directory: `services/pdf-parser`
- Dockerfile: `services/pdf-parser/Dockerfile`
- Env: `PARSER_INTERNAL_TOKEN=<token_lungo_random>`
- Auth servizio: pubblica (protezione applicativa via token header)
