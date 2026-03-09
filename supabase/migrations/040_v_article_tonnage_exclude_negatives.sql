-- v_article_tonnage: exclude negative-price lines (discounts/adjustments) from quantity counting
-- v_article_costs_by_phase is intentionally NOT filtered — negative lines are needed for economic breakdown

CREATE OR REPLACE VIEW v_article_tonnage WITH (security_invoker = true) AS
-- Multi-step articles: only counting_point phases, exclude negative lines (discounts/adjustments)
SELECT
  a.company_id,
  a.id AS article_id, a.code AS article_code, a.name AS article_name,
  ap.id AS phase_id, ap.name AS phase_name,
  date_trunc('month', i.date::timestamp with time zone) AS month,
  i.direction AS invoice_direction,
  sum(COALESCE(ila.quantity, il.quantity)) AS total_quantity,
  sum(COALESCE(ila.total_price, il.total_price)) AS total_amount,
  count(*) AS line_count
FROM articles a
JOIN article_phases ap ON ap.article_id = a.id AND ap.is_counting_point = true
JOIN invoice_line_articles ila ON ila.article_id = a.id AND ila.phase_id = ap.id
JOIN invoice_lines il ON il.id = ila.invoice_line_id
JOIN invoices i ON i.id = ila.invoice_id
WHERE a.active = true
  AND COALESCE(il.total_price, 0) > 0  -- exclude discount/adjustment lines
GROUP BY a.company_id, a.id, a.code, a.name, ap.id, ap.name,
         date_trunc('month', i.date::timestamp with time zone), i.direction

UNION ALL

-- Single-step articles (no phases): exclude negative lines
SELECT
  a.company_id,
  a.id AS article_id, a.code AS article_code, a.name AS article_name,
  NULL::uuid AS phase_id, NULL::text AS phase_name,
  date_trunc('month', i.date::timestamp with time zone) AS month,
  i.direction AS invoice_direction,
  sum(COALESCE(ila.quantity, il.quantity)) AS total_quantity,
  sum(COALESCE(ila.total_price, il.total_price)) AS total_amount,
  count(*) AS line_count
FROM articles a
JOIN invoice_line_articles ila ON ila.article_id = a.id AND ila.phase_id IS NULL
JOIN invoice_lines il ON il.id = ila.invoice_line_id
JOIN invoices i ON i.id = ila.invoice_id
WHERE a.active = true
  AND NOT EXISTS (SELECT 1 FROM article_phases ap2 WHERE ap2.article_id = a.id AND ap2.active = true)
  AND COALESCE(il.total_price, 0) > 0  -- exclude discount/adjustment lines
GROUP BY a.company_id, a.id, a.code, a.name,
         date_trunc('month', i.date::timestamp with time zone), i.direction;
