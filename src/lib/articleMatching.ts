/**
 * articleMatching.ts — Shared deterministic matching logic for articles
 *
 * Single source of truth for:
 * - matchLineToArticle (keyword-based)
 * - matchWithLearnedRules (rules-first, keyword-fallback)
 * - extractLocation
 * - suggestKeywords
 *
 * Used by: ArticoliPage (assignment tab), FatturePage (inline dropdown)
 */

import type { Article, MatchResult } from '@/lib/articlesService'

/* ─── Learned Rule types ────────────────────── */

export interface LearnedRule {
  id: string
  article_id: string
  pattern: { description_contains?: string[] } | null
  confidence: number
  hit_count: number
  reject_count: number
  source: string
}

/* ─── Keyword-based matching (pure, sync) ──── */

/**
 * Match a line description against all articles using keyword matching.
 * Returns the best match above threshold, or null.
 */
export function matchLineToArticle(
  lineDescription: string,
  articles: Article[],
): MatchResult | null {
  if (!lineDescription) return null
  const desc = lineDescription.toUpperCase()

  let bestMatch: MatchResult | null = null

  for (const article of articles) {
    const keywords = article.keywords || []
    if (keywords.length === 0 || !article.active) continue

    const matchedKeywords = keywords.filter(kw => desc.includes(kw.toUpperCase()))
    if (matchedKeywords.length === 0) continue

    const matchRatio = matchedKeywords.length / keywords.length
    const confidence = Math.min(matchRatio * 100, 98)

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        article,
        confidence,
        matchedKeywords,
        totalKeywords: keywords.length,
      }
    }
  }

  return bestMatch
}

/* ─── Enhanced matching with learned rules ── */

/**
 * Match a line description using learned rules first (confidence > 0.5),
 * then fall back to keyword matching.
 *
 * Rules are pre-loaded and passed in to keep this function synchronous.
 * Each rule has a `pattern.description_contains` array of uppercase keywords.
 * A rule "matches" if ALL its keywords are found in the description.
 */
export function matchWithLearnedRules(
  lineDescription: string,
  articles: Article[],
  rules: LearnedRule[],
): MatchResult | null {
  if (!lineDescription) return null
  const desc = lineDescription.toUpperCase()

  // Phase 1: check learned rules (only those with confidence > 0.5)
  const validRules = rules.filter(r => r.confidence > 0.5)

  let bestRuleMatch: { rule: LearnedRule; article: Article; matchedKws: string[] } | null = null
  let bestRuleConf = 0

  for (const rule of validRules) {
    const ruleKeywords = rule.pattern?.description_contains || []
    if (ruleKeywords.length === 0) continue

    // At least 70% of keywords must match (not 100%)
    const matched = ruleKeywords.filter(kw => desc.includes(kw.toUpperCase()))
    const matchRatio = matched.length / ruleKeywords.length
    if (matchRatio < 0.7) continue

    // Rule matches — scale confidence by match ratio
    const ruleConf = rule.confidence * matchRatio * 100 // normalize 0-1 → 0-100, scaled by match %
    if (ruleConf > bestRuleConf) {
      const article = articles.find(a => a.id === rule.article_id)
      if (article && article.active) {
        bestRuleMatch = { rule, article, matchedKws: matched }
        bestRuleConf = ruleConf
      }
    }
  }

  if (bestRuleMatch) {
    return {
      article: bestRuleMatch.article,
      confidence: Math.min(bestRuleConf, 98),
      matchedKeywords: bestRuleMatch.matchedKws,
      totalKeywords: bestRuleMatch.matchedKws.length,
    }
  }

  // Phase 2: fallback to keyword matching
  return matchLineToArticle(lineDescription, articles)
}

/* ─── Location extraction ────────────────────── */

/**
 * Extract location/site from invoice line description.
 * Common patterns in CAVECO invoices.
 */
export function extractLocation(description: string): string | null {
  if (!description) return null
  const patterns: RegExp[] = [
    /Cava\s+([\w\s]+?)\s*\(([A-Z]{2})\)/i,           // "Cava Serle (BS)"
    /Cava\s+([\w\s]+?)\s*[–\-]/i,                     // "Cava Ponte Lucano –"
    /Stabilimento\s+(?:di\s+)?([\w]+)/i,               // "Stabilimento di Guidonia"
    /([\w]+)\s*\((BS|RM|VC|VT|PG|AN)\)/i,             // "Paitone (BS)"
  ]

  for (const pattern of patterns) {
    const match = description.match(pattern)
    if (match) {
      if (match[2]) return `${match[1].trim()} (${match[2]})`
      return match[1].trim()
    }
  }
  return null
}

/* ─── Keyword suggestion ──────────────────── */

/**
 * Suggest keywords from an article name.
 * Splits name into words, filters out short/common words, lowercases.
 */
export function suggestKeywords(name: string): string[] {
  if (!name) return []
  const stopWords = new Set([
    'di', 'da', 'a', 'in', 'per', 'con', 'su', 'e', 'il', 'la', 'lo', 'i', 'le', 'gli',
    'un', 'una', 'del', 'della', 'dello', 'dei', 'delle', 'degli', 'al', 'alla', 'allo',
    'mm', 'mt', 'kg', 'nr', 'pz', 'lt',
  ])

  return name
    .split(/[\s\-–,;.()\/]+/)
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length >= 2 && !stopWords.has(w))
}
