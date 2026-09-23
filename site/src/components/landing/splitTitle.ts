/**
 * Split a heading around its highlighted phrase so the phrase can be wrapped in
 * <em> (italic, accent-tinted). YAML carries `title` (full text) + `titleEm`
 * (the phrase); a missing or non-matching phrase renders the title plain.
 */
export function splitTitle(title = '', em?: string): { before: string; em: string; after: string } {
  if (!em || !title.includes(em)) return { before: title, em: '', after: '' }
  const i = title.indexOf(em)
  return { before: title.slice(0, i), em, after: title.slice(i + em.length) }
}
