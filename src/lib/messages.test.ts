import { expect } from 'chai';
import {
    displayName,
    exhaustedText,
    invalidText,
    missingText,
    pickLang,
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

    it('names the attempts when giving up', () => {
        expect(exhaustedText('en', 'Washer', 'a.0.s', 3, 'a.0')).to.equal(
            "'Washer' (a.0.s) is still silent after 3 restart(s) of a.0. No further attempts.",
        );
    });

    it('writes the remaining texts in both languages', () => {
        for (const lang of ['de', 'en'] as const) {
            expect(recoveredText(lang, 'W', 'a.0.s')).to.contain('a.0.s');
            expect(missingText(lang, 'a.0.s')).to.contain('a.0.s');
            expect(invalidText(lang, 'a.0.s', 'bad mode')).to.contain('bad mode');
            expect(restartFailedText(lang, 'a.0', 'denied')).to.contain('denied');
        }
    });
});
