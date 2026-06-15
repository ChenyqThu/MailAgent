import { defineCollection } from 'astro:content'
// Import z from astro/zod (the non-deprecated source on Astro 6). Astro 6
// deprecated the `z` re-export from 'astro:content', and its `z.infer<>`
// namespace usage failed typecheck (ts2503). astro/zod is the supported path.
import { z } from 'astro/zod'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { glob } from 'astro/loaders'

/**
 * Content collections (Astro 6 + Starlight 0.40).
 *
 *  - `docs`    : Starlight's docs collection (101 + agent guides). Uses the
 *                official docsLoader + docsSchema. Files live in
 *                src/content/docs/** (zh root) and src/content/docs/en/**.
 *  - `landing` : structured marketing copy, one YAML per locale under
 *                src/content/landing/*.yaml. Schema is intentionally TOLERANT
 *                (almost everything optional + .loose()) so Lane A can
 *                iterate on copy without schema fights — it documents shape,
 *                it does not gate iteration.
 */

// A landing-section meta item: an icon-less label/value used in hero meta etc.
const metaItem = z.object({ text: z.string() }).loose()

// A generic "card" used by features/strip/proof-points/etc.
const card = z
  .object({
    kicker: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
  })
  .loose()

// A feature-list <li> { title, body }
const fItem = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
  })
  .loose()

const landingSchema = z
  .object({
    // page-level SEO
    seo: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
      })
      .loose()
      .optional(),

    // NAV
    nav: z
      .object({
        links: z.array(z.object({ label: z.string(), href: z.string() }).loose()).optional(),
        download: z.string().optional(),
      })
      .loose()
      .optional(),

    // HERO
    hero: z
      .object({
        pill: z.string().optional(),
        pillTag: z.string().optional(),
        title: z.string().optional(),
        titleEm: z.string().optional(),
        sub: z.string().optional(),
        ctaPrimary: z.string().optional(),
        ctaGhost: z.string().optional(),
        meta: z.array(metaItem).optional(),
      })
      .loose()
      .optional(),

    // STRIP (one email · five things)
    strip: z
      .object({
        label: z.string().optional(),
        items: z.array(z.string()).optional(),
      })
      .loose()
      .optional(),

    // FEATURES (AI Triage grid)
    features: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        lede: z.string().optional(),
        cards: z.array(card).optional(),
      })
      .loose()
      .optional(),

    // AI FIELDS (split)
    aiFields: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        points: z.array(fItem).optional(),
      })
      .loose()
      .optional(),

    // PING ISLAND
    island: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        points: z.array(fItem).optional(),
      })
      .loose()
      .optional(),

    // REPORT AGENT
    report: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        titleEm: z.string().optional(),
        lede: z.string().optional(),
        points: z.array(fItem).optional(),
      })
      .loose()
      .optional(),

    // CUSTOM AI / KOS
    customAI: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        points: z.array(fItem).optional(),
      })
      .loose()
      .optional(),

    // PROVENANCE (anti-hallucination)
    provenance: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        titleEm: z.string().optional(),
        lede: z.string().optional(),
        points: z.array(fItem).optional(),
      })
      .loose()
      .optional(),

    // OBSERVABILITY (LLM dashboard)
    observability: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        titleEm: z.string().optional(),
        lede: z.string().optional(),
        stats: z
          .array(z.object({ value: z.string(), key: z.string(), sub: z.string().optional() }).loose())
          .optional(),
      })
      .loose()
      .optional(),

    // MOBILE
    mobile: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        chips: z.array(z.string()).optional(),
      })
      .loose()
      .optional(),

    // DOWNLOAD
    download: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        ctaPrimary: z.string().optional(),
        ctaGhost: z.string().optional(),
        steps: z.array(card).optional(),
        note: z.string().optional(),
      })
      .loose()
      .optional(),

    // FAQ
    faq: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        items: z.array(z.object({ q: z.string(), a: z.string() }).loose()).optional(),
      })
      .loose()
      .optional(),

    // FOOTER
    footer: z
      .object({
        tagline: z.string().optional(),
        cols: z
          .array(
            z
              .object({
                heading: z.string(),
                links: z.array(z.object({ label: z.string(), href: z.string() }).loose()),
              })
              .loose()
          )
          .optional(),
        copyright: z.string().optional(),
        built: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose()

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  landing: defineCollection({
    // generateId preserves the filename stem VERBATIM (incl. case), so
    // getEntry('landing','zh-CN') matches zh-CN.yaml. The default glob id
    // slugifies (lowercases) → 'zh-cn', which would silently miss.
    loader: glob({
      pattern: '*.yaml',
      base: './src/content/landing',
      generateId: ({ entry }) => entry.replace(/\.ya?ml$/, ''),
    }),
    schema: landingSchema,
  }),
}

export type LandingData = z.infer<typeof landingSchema>
