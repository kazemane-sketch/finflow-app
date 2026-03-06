/**
 * articleMatching.ts — Shared deterministic matching logic for articles
 *
 * Single source of truth for:
 * - matchLineToArticle (keyword-based)
 * - matchWithLearnedRules (rules-first, keyword-fallback)
 * - matchWithLearnedRulesAll (ALL candidates for ambiguity detection)
 * - needsAiMatching (determines if Haiku Level 2 is needed)
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
        source: 'deterministic',
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
      source: 'deterministic',
    }
  }

  // Phase 2: fallback to keyword matching
  return matchLineToArticle(lineDescription, articles)
}

/* ─── All-matches variant (for ambiguity detection) ── */

/**
 * Like matchWithLearnedRules, but returns ALL candidates sorted by confidence.
 * Used to detect ambiguous cases where Haiku Level 2 should take over.
 */
export function matchWithLearnedRulesAll(
  lineDescription: string,
  articles: Article[],
  rules: LearnedRule[],
): MatchResult[] {
  if (!lineDescription) return []
  const desc = lineDescription.toUpperCase()
  const results: MatchResult[] = []
  const matchedArticleIds = new Set<string>()

  // Phase 1: check learned rules (only those with confidence > 0.5)
  const validRules = rules.filter(r => r.confidence > 0.5)

  for (const rule of validRules) {
    const ruleKeywords = rule.pattern?.description_contains || []
    if (ruleKeywords.length === 0) continue

    const matched = ruleKeywords.filter(kw => desc.includes(kw.toUpperCase()))
    const matchRatio = matched.length / ruleKeywords.length
    if (matchRatio < 0.7) continue

    const article = articles.find(a => a.id === rule.article_id)
    if (!article || !article.active) continue

    // If we already have a match for this article (from a different rule), keep the best
    if (matchedArticleIds.has(article.id)) {
      const existing = results.find(r => r.article.id === article.id)
      const ruleConf = Math.min(rule.confidence * matchRatio * 100, 98)
      if (existing && ruleConf > existing.confidence) {
        existing.confidence = ruleConf
        existing.matchedKeywords = matched
      }
      continue
    }

    results.push({
      article,
      confidence: Math.min(rule.confidence * matchRatio * 100, 98),
      matchedKeywords: matched,
      totalKeywords: matched.length,
      source: 'deterministic',
    })
    matchedArticleIds.add(article.id)
  }

  // Phase 2: keyword matching for articles not already matched by rules
  for (const article of articles) {
    if (matchedArticleIds.has(article.id)) continue
    const keywords = article.keywords || []
    if (keywords.length === 0 || !article.active) continue

    const matchedKws = keywords.filter(kw => desc.includes(kw.toUpperCase()))
    if (matchedKws.length === 0) continue

    const matchRatio = matchedKws.length / keywords.length
    results.push({
      article,
      confidence: Math.min(matchRatio * 100, 98),
      matchedKeywords: matchedKws,
      totalKeywords: keywords.length,
      source: 'deterministic',
    })
  }

  // Sort by confidence descending
  return results.sort((a, b) => b.confidence - a.confidence)
}

/* ─── Ambiguity detection ─────────────────────── */

/**
 * Determine if a line needs AI (Haiku Level 2) based on its match candidates.
 *
 * Returns true (needs AI) when:
 * - No matches at all
 * - Best match confidence < 50 (too weak)
 * - Two+ candidates within 30 points of each other (ambiguous)
 * - Single match with confidence ≤ 85 (borderline)
 *
 * Returns false (deterministic is fine) when:
 * - Single match with confidence > 85 (clear winner)
 * - Top match is 30+ points ahead of runner-up (decisive lead)
 */
export function needsAiMatching(allMatches: MatchResult[]): boolean {
  if (allMatches.length === 0) return true

  const top1 = allMatches[0].confidence

  // Single match with confidence > 85 → deterministic
  if (allMatches.length === 1 && top1 > 85) return false

  // Best match too weak → AI
  if (top1 < 50) return true

  // Two+ matches: check if gap is decisive
  if (allMatches.length >= 2) {
    const top2 = allMatches[1].confidence
    if (top1 - top2 < 30) return true // too close → AI
  }

  // Single match with moderate confidence → AI
  if (allMatches.length === 1 && top1 <= 85) return true

  // Decisive lead with strong top match → deterministic
  return false
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
