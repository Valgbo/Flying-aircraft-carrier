import { describe, expect, it } from 'vitest';
import { PROJECT_LICENCE, THIRD_PARTY } from '../../../src/a10/ui/credits';

/** CREDITS.md, when the asset pipeline has written it (empty object otherwise). */
const creditsMd = import.meta.glob<string>('/CREDITS.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('credits screen', () => {
  it('names the licence and the FlightGear A-10 authors and source', () => {
    expect(PROJECT_LICENCE.spdx).toBe('GPL-2.0-or-later');
    const fg = THIRD_PARTY.find((c) => c.source.url === 'https://github.com/l0k1/A-10');
    expect(fg).toBeDefined();
    expect(fg!.authors).toEqual([
      'Lee Elliott',
      'Alexis Bory',
      'David Bastien',
      'Pinto',
      'Rudolf',
      'JMaverick16',
      'Zorka',
      'SammySkycrafts',
    ]);
    expect(fg!.licence).toMatch(/GPL/);
  });

  it('mirrors CREDITS.md: every author and source URL there is on the credits screen', () => {
    const text = Object.values(creditsMd)[0];
    if (text === undefined) return; // not written yet
    const screen = JSON.stringify(THIRD_PARTY);
    const urls = text.match(/https?:\/\/[^\s)>\]'"`]+/g) ?? [];
    for (const raw of urls) {
      // links to licence texts and documentation need not be on the screen
      if (/gnu\.org|creativecommons\.org|wikipedia\.org|flightgear\.org|spdx\.org/i.test(raw))
        continue;
      const url = new URL(raw.replace(/[.,;:]+$/, ''));
      // a GitHub source is credited by its repository, anything else by its site
      const repo = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      const source =
        url.hostname === 'github.com'
          ? `https://github.com/${repo.replace(/\.git$/, '')}`
          : `${url.protocol}//${url.hostname}`;
      expect(screen, `CREDITS.md source ${raw}`).toContain(source);
    }
    // every entry on the screen is a source CREDITS.md credits, under the same name
    for (const c of THIRD_PARTY) expect(text, c.title).toContain(c.creditsMd);
    // the FlightGear authors are named in CREDITS.md exactly as on the screen
    const fg = THIRD_PARTY.find((c) => c.creditsMd === 'FlightGear A-10')!;
    for (const a of fg.authors) expect(text).toContain(a);
    // and a tool CREDITS.md names for a generated file is on the screen too
    if (/\bFlite\b/.test(text)) expect(THIRD_PARTY.some((c) => /Flite/.test(c.title))).toBe(true);
  });
});
