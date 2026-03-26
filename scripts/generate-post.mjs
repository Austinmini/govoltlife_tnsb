/* eslint-disable */
// scripts/generate-post.mjs
// Fetches trending news, generates a blog post with Claude, injects Amazon affiliate links
// Uses Amazon Creators API (successor to PA API 5.0, retiring May 2026)

import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const TOPIC_ROTATION = [
  { topic: 'solar energy', keywords: ['solar panels', 'solar power', 'photovoltaic', 'home solar'] },
  { topic: 'electric vehicles', keywords: ['EV', 'electric car', 'EV charging', 'Tesla', 'Rivian', 'EV battery'] },
  { topic: 'sustainability', keywords: ['sustainable living', 'green energy', 'eco-friendly products', 'carbon footprint'] },
]

// Rotate topic based on day of year so each run picks a different theme
const topicIndex = Math.floor(Date.now() / (24 * 60 * 60 * 1000)) % TOPIC_ROTATION.length
const currentTopic = TOPIC_ROTATION[topicIndex]

// Amazon Creators API base URL
// Credentials come from: affiliate-program.amazon.com/creatorsapi
// Create App → Add New Credential → copy Credential ID + Credential Secret
const CREATORS_API_BASE = 'https://affiliate-program.amazon.com/creatorsapi/rest/v1'

// ─── STEP 1: FETCH TRENDING NEWS ─────────────────────────────────────────────

async function fetchNews(topic) {
  const query = encodeURIComponent(`${topic} 2025`)
  const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${process.env.NEWS_API_KEY}`

  const res = await fetch(url)
  const data = await res.json()

  if (!data.articles || data.articles.length === 0) {
    throw new Error(`No news articles found for topic: ${topic}`)
  }

  return data.articles.slice(0, 4).map(a => ({
    title: a.title,
    description: a.description,
    source: a.source?.name,
    publishedAt: a.publishedAt,
    url: a.url,
  }))
}

// ─── STEP 2: GENERATE POST WITH CLAUDE ───────────────────────────────────────

async function generateBlogPost(topic, keywords, newsArticles) {
  const newsContext = newsArticles
    .map((a, i) => `${i + 1}. "${a.title}" (${a.source}): ${a.description}`)
    .join('\n')

  const prompt = `You are a blogger for GoVoltLife (govoltlife.com), a blog about solar energy, EVs, and sustainable living. 
Your tone is informative, enthusiastic, and practical — aimed at homeowners interested in clean energy and green living.

Today's topic: ${topic}

Recent news to draw from:
${newsContext}

Write a complete blog post in MDX format (Markdown). The post should:
1. Be 700–1000 words
2. Have an engaging, SEO-friendly title
3. Include a brief intro paragraph
4. Have 3–4 clear sections with ## headings
5. Reference 2–3 real current trends from the news above (don't fabricate statistics)
6. Recommend 2–3 specific products the reader could buy (real product names). Format each product recommendation like this exactly:
   {{PRODUCT: product name here}}
   For example: {{PRODUCT: EcoFlow DELTA 2 Portable Power Station}}
7. End with a practical takeaway or call to action
8. Be informative and authentic — don't sound like AI spam

IMPORTANT: Output ONLY the blog post content starting from the title. Do not include frontmatter, code fences, or any preamble.
Start with: # [Your Title Here]`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`)
  return data.content[0].text
}

// ─── STEP 3: AMAZON CREATORS API — OAuth 2.0 TOKEN ───────────────────────────
// Docs: affiliate-program.amazon.com/creatorsapi/docs/en-us/onboarding/register-for-creators-api
// To get credentials:
//   1. Go to affiliate-program.amazon.com/creatorsapi
//   2. Click "Create App" → give it a name (e.g. "GoVoltLife Blog")
//   3. Click "Add New Credential" → copy Credential ID + Credential Secret
//      (Secret is shown only once — save it immediately!)
//   4. Add to GitHub Secrets as AMAZON_CREDENTIAL_ID and AMAZON_CREDENTIAL_SECRET

let _cachedToken = null
let _tokenExpiry = 0

async function getCreatorsApiToken() {
  // Reuse cached token if still valid (tokens typically last 1 hour)
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken

  const credentialId = process.env.AMAZON_CREDENTIAL_ID
  const credentialSecret = process.env.AMAZON_CREDENTIAL_SECRET

  if (!credentialId || !credentialSecret) {
    return null // will fall back to search URLs
  }

  // OAuth 2.0 client credentials flow
  const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentialId,
      client_secret: credentialSecret,
      scope: 'paapi',
    }),
  })

  const tokenData = await tokenRes.json()
  if (!tokenRes.ok || !tokenData.access_token) {
    console.warn(`Failed to get Creators API token: ${JSON.stringify(tokenData)}`)
    return null
  }

  _cachedToken = tokenData.access_token
  _tokenExpiry = Date.now() + (tokenData.expires_in - 60) * 1000 // refresh 60s early
  return _cachedToken
}

// ─── STEP 4: LOOK UP AMAZON AFFILIATE LINKS VIA CREATORS API ─────────────────

async function getAmazonAffiliateLink(productName) {
  const associateTag = process.env.AMAZON_ASSOCIATE_TAG || 'govoltlife-20'

  // Fallback: affiliate search URL (still earns commissions even without API)
  const fallbackUrl = `https://www.amazon.com/s?k=${encodeURIComponent(productName)}&tag=${associateTag}`

  try {
    const token = await getCreatorsApiToken()

    if (!token) {
      console.log(`No Creators API token — using search URL for: ${productName}`)
      return fallbackUrl
    }

    // Creators API SearchItems — note camelCase payload (unlike PA API's PascalCase)
    const payload = {
      keywords: productName,
      resources: ['itemInfo.title', 'offers.listings.price', 'images.primary.medium'],
      searchIndex: 'All',
      itemCount: 1,
      partnerTag: associateTag,
      partnerType: 'Associates',
      marketplace: 'www.amazon.com',
    }

    const res = await fetch(`${CREATORS_API_BASE}/searchItems`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })

    const data = await res.json()
    const item = data?.searchResult?.items?.[0]

    if (item?.asin) {
      return `https://www.amazon.com/dp/${item.asin}?tag=${associateTag}`
    }

    console.warn(`No product found for "${productName}", using search fallback`)
    return fallbackUrl

  } catch (err) {
    console.warn(`Creators API lookup failed for "${productName}":`, err.message)
    return fallbackUrl
  }
}

// ─── STEP 5: INJECT AFFILIATE LINKS ──────────────────────────────────────────

async function injectAffiliateLinks(content) {
  const productMatches = [...content.matchAll(/\{\{PRODUCT: (.+?)\}\}/g)]
  let updatedContent = content

  for (const match of productMatches) {
    const fullMatch = match[0]
    const productName = match[1].trim()
    const affiliateUrl = await getAmazonAffiliateLink(productName)

    const mdLink = `[${productName}](${affiliateUrl})`
    updatedContent = updatedContent.replace(fullMatch, mdLink)
    console.log(`Linked product: ${productName} → ${affiliateUrl}`)
  }

  return updatedContent
}

// ─── STEP 6: BUILD MDX FILE ───────────────────────────────────────────────────

function buildMdxFile(content, topic) {
  const titleMatch = content.match(/^# (.+)$/m)
  const title = titleMatch ? titleMatch[1].trim() : `Latest in ${topic}`
  const bodyContent = content.replace(/^# .+\n/, '').trim()

  const date = new Date().toISOString().split('T')[0]
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)

  const tagMap = {
    'solar energy': ['solar', 'renewable-energy', 'solar-panels'],
    'electric vehicles': ['ev', 'electric-vehicles', 'clean-transport'],
    'sustainability': ['sustainability', 'eco-friendly', 'green-living'],
  }
  const tags = tagMap[topic] || ['green-energy']

  const frontmatter = `---
title: '${title.replace(/'/g, "''")}'
date: '${date}'
lastmod: '${date}'
tags: [${tags.map(t => `'${t}'`).join(', ')}]
draft: false
summary: 'Auto-generated post covering the latest ${topic} news and product recommendations.'
---

`
  const disclaimer = `> *Disclosure: This post contains Amazon affiliate links. We may earn a small commission at no extra cost to you if you purchase through these links.*\n\n`

  return {
    slug,
    content: frontmatter + disclaimer + bodyContent,
    filename: `${date}-${slug}.mdx`,
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const { topic, keywords } = currentTopic
  console.log(`Generating post for topic: ${topic}`)

  const news = await fetchNews(topic)
  console.log(`Fetched ${news.length} news articles`)

  let content = await generateBlogPost(topic, keywords, news)
  console.log('Claude generated post successfully')

  content = await injectAffiliateLinks(content)
  console.log('Affiliate links injected')

  const { slug, content: mdxContent, filename } = buildMdxFile(content, topic)
  console.log(`Building MDX: ${filename}`)

  const outputDir = path.resolve('data/blog')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, filename), mdxContent, 'utf-8')

  console.log(`Post written: data/blog/${filename}`)
}

main().catch(err => {
  console.error('Post generation failed:', err)
  process.exit(1)
})
