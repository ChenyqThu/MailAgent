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

// A kicker/title/body card — the download block's install steps.
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

// A numbered feature block: eyebrow · title (+ highlighted phrase) · lede ·
// feature points · optional cards (the 连接 block's integration tiles).
const section = z
  .object({
    eyebrow: z.string().optional(),
    title: z.string().optional(),
    titleEm: z.string().optional(),
    lede: z.string().optional(),
    points: z.array(fItem).optional(),
    cards: z.array(fItem).optional(),
  })
  .loose()
  .optional()

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

    // FEATURE SECTIONS — every numbered block (今日 / 分拣 / 事项 / 人与时间 /
    // 资料库 / 团队 / 报告 / 对话 / 信任 / 连接) shares one shape; the page
    // picks the layout, the YAML only carries copy.
    today: section,
    triage: section,
    matters: section,
    people: section,
    library: section,
    team: section,
    reports: section,
    chat: section,
    trust: section,
    connect: section,

    // DOWNLOAD
    download: z
      .object({
        eyebrow: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        ctaPrimary: z.string().optional(),
        ctaWin: z.string().optional(),
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
