import { expect } from 'chai';
import {
    displayName,
    exhaustedText,
    invalidText,
    joinLines,
    missingText,
    pickLang,
    reasonText,
    recoveredText,
    restartFailedText,
    staleText,
} from './messages';

describe('messages', () => {
    it('uses German for de and English for everything else', () => {
        expect(pickLang('de')).to.equal('de');
        expect(pickLang('fr')).to.equal('en');
        expect(pickLang(undefined)).to.equal('en');
    });

    it('resolves plain and translated names and falls back to the id', () => {
        expect(displayName('Washer', 'de', 'x')).to.equal('Washer');
        expect(displayName({ en: 'Washer', de: 'Waschmaschine' }, 'de', 'x')).to.equal('Waschmaschine');
        expect(displayName({ en: 'Washer' }, 'de', 'x')).to.equal('Washer');
        expect(displayName({ fr: 'Lave-linge' }, 'de', 'x')).to.equal('x');
        expect(displayName('  ', 'en', 'x')).to.equal('x');
        expect(displayName(42, 'en', 'x')).to.equal('x');
    });

    it('writes the stale text with and without a restart', () => {
        expect(staleText('de', 'Waschmaschine', 'a.0.s', 45, null)).to.equal(
            "Kein Lebenszeichen von 'Waschmaschine' (a.0.s) seit 45 min.",
        );
        expect(staleText('en', 'Washer', 'a.0.s', 45, 'a.0')).to.equal(
            "No sign of life from 'Washer' (a.0.s) for 45 min. Restarting instance a.0.",
        );
    });

    it('shows long silences in hours and days', () => {
        const silence = (lang: 'de' | 'en', minutes: number): string =>
            staleText(lang, 'W', 'a', minutes, null).replace(/^.* (seit|for) /, '');
        expect(silence('en', 0)).to.equal('0 min.');
        expect(silence('en', 119)).to.equal('119 min.');
        expect(silence('en', 120)).to.equal('2 hours.');
        expect(silence('de', 120)).to.equal('2 Stunden.');
        expect(silence('en', 2849)).to.equal('47 hours.');
        expect(silence('en', 2850)).to.equal('2 days.');
        expect(silence('de', 10085)).to.equal('7 Tagen.');
    });

    it('names the attempts when giving up', () => {
        expect(exhaustedText('en', 'Washer', 'a.0.s', 3, 'a.0')).to.equal(
            "'Washer' (a.0.s) is still silent after 3 restart(s) of a.0. No further attempts.",
        );
    });

    it('writes the remaining texts in both languages', () => {
        for (const lang of ['de', 'en'] as const) {
            expect(recoveredText(lang, 'W', 'a.0.s')).to.contain('a.0.s');
            expect(missingText(lang, 'a.0.s')).to.contain('a.0.s');
            expect(invalidText(lang, 'a.0.s', { code: 'noOwner' })).to.contain('a.0.s');
            expect(restartFailedText(lang, 'a.0', 'denied')).to.contain('denied');
        }
    });

    it('explains every rejected setting in German and English', () => {
        const cases = [
            { problem: { code: 'ownStates' }, part: '' },
            { problem: { code: 'timeout', value: 0 }, part: '0' },
            { problem: { code: 'mode', value: 'value' }, part: '"value"' },
            { problem: { code: 'attempts', value: 6 }, part: '6' },
            { problem: { code: 'noOwner' }, part: '' },
            { problem: { code: 'collision', other: 'a.0.x.y' }, part: 'a.0.x.y' },
            { problem: { code: 'cap', max: 5000 }, part: '5000' },
        ] as const;
        for (const { problem, part } of cases) {
            const de = reasonText('de', problem);
            const en = reasonText('en', problem);
            expect(de, problem.code).to.not.equal(en);
            expect(de, problem.code).to.contain(part);
            expect(en, problem.code).to.contain(part);
        }
    });

    it('shows a missing or odd value readably', () => {
        expect(reasonText('en', { code: 'timeout', value: null })).to.contain('null');
        expect(reasonText('en', { code: 'timeout', value: '30' })).to.contain('"30"');
    });

    it('writes a German invalid-setting text without English parts', () => {
        expect(invalidText('de', 'a.0.s', { code: 'timeout', value: 0 })).to.equal(
            'Die Überwachung von a.0.s ist ungültig eingestellt: „Frist (min)“ muss eine ganze Zahl von 1 bis 10080 sein, eingestellt ist 0.',
        );
    });

    it('joins the lines of one check and cuts long lists with a count', () => {
        expect(joinLines('en', ['a'])).to.equal('a');
        expect(joinLines('en', ['a', 'b'], 2)).to.equal('a\nb');
        expect(joinLines('en', ['a', 'b', 'c'], 2)).to.equal('a\nb\n… and 1 more.');
        expect(joinLines('de', ['a', 'b', 'c', 'd'], 2)).to.equal('a\nb\n… und 2 weitere.');
    });
});
