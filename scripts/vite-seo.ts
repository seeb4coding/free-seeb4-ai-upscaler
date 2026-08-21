import type { Plugin } from 'vite';

/** Entities that actually appear in the copy; enough to un-escape it. */
const ENTITIES: Record<string, string> = {
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&times;': '\u00d7',
  '&hellip;': '\u2026',
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function toText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Emits FAQPage structured data built from the FAQ that is actually on the
 * page. Google only honours FAQ markup whose questions and answers match the
 * visible copy, so deriving it here beats keeping a hand-written second copy
 * of every answer in sync.
 */
export function faqSchema(): Plugin {
  return {
    name: 'seeb4-faq-schema',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const faq = html.match(/<section class="faq"[\s\S]*?<\/section>/);
        if (!faq) throw new Error('seeb4-faq-schema: no <section class="faq"> in index.html');

        const items = [...faq[0].matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
          .map(([, question, answer]) => ({
            '@type': 'Question',
            name: toText(question),
            acceptedAnswer: { '@type': 'Answer', text: toText(answer) },
          }))
          .filter((item) => item.name && item.acceptedAnswer.text);

        if (!items.length) {
          throw new Error('seeb4-faq-schema: FAQ section parsed, but no question/answer pairs found');
        }

        return {
          html,
          tags: [
            {
              tag: 'script',
              attrs: { type: 'application/ld+json' },
              children: JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'FAQPage',
                mainEntity: items,
              }),
              injectTo: 'head' as const,
            },
          ],
        };
      },
    },
  };
}
