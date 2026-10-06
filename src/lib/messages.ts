/**
 * Notification texts. An ioBroker notification carries one finished string, so the text is built
 * in the system language here instead of through admin i18n.
 */

import type { WatchProblem } from './watchlist';

export type Lang = 'de' | 'en';

/**
 * German for a German system, English for every other language.
 *
 * @param language `system.config` `common.language`
 */
export function pickLang(language: unknown): Lang {
    return language === 'de' ? 'de' : 'en';
}

/**
 * Readable name of a watched object: the plain name, the translation for `lang`, the English
 * translation, else the fallback.
 *
 * @param name `common.name` of the watched object
 * @param lang notification language
 * @param fallback usually the state id
 */
export function displayName(name: unknown, lang: Lang, fallback: string): string {
    if (typeof name === 'string') {
        return name.trim() ? name : fallback;
    }
    if (typeof name === 'object' && name !== null) {
        const translated = name as Record<string, unknown>;
        for (const key of [lang, 'en']) {
            const value = translated[key];
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
        }
    }
    return fallback;
}

/**
 * State went silent.
 *
 * @param lang notification language
 * @param name display name
 * @param id state id
 * @param minutes minutes since the last sign of life
 * @param restarting instance being restarted now, or null
 */
export function staleText(lang: Lang, name: string, id: string, minutes: number, restarting: string | null): string {
    if (lang === 'de') {
        return `Kein Lebenszeichen von '${name}' (${id}) seit ${minutes} min.${restarting ? ` Instanz ${restarting} wird neu gestartet.` : ''}`;
    }
    return `No sign of life from '${name}' (${id}) for ${minutes} min.${restarting ? ` Restarting instance ${restarting}.` : ''}`;
}

/**
 * Last restart attempt did not help.
 *
 * @param lang notification language
 * @param name display name
 * @param id state id
 * @param attempts restarts made in this outage
 * @param instance restarted instance
 */
export function exhaustedText(lang: Lang, name: string, id: string, attempts: number, instance: string): string {
    if (lang === 'de') {
        return `'${name}' (${id}) ist nach ${attempts} Neustart(s) von ${instance} weiter ohne Lebenszeichen. Keine weiteren Versuche.`;
    }
    return `'${name}' (${id}) is still silent after ${attempts} restart(s) of ${instance}. No further attempts.`;
}

/**
 * State is alive again.
 *
 * @param lang notification language
 * @param name display name
 * @param id state id
 */
export function recoveredText(lang: Lang, name: string, id: string): string {
    return lang === 'de' ? `'${name}' (${id}) sendet wieder.` : `'${name}' (${id}) is sending again.`;
}

/**
 * Watched object or state does not exist.
 *
 * @param lang notification language
 * @param id state id
 */
export function missingText(lang: Lang, id: string): string {
    return lang === 'de'
        ? `Der überwachte State ${id} existiert nicht oder hat keinen gültigen Wert.`
        : `The watched state ${id} does not exist or has no valid value.`;
}

/**
 * Lines of one category from one check, as one notification. Long lists are cut, so a mass
 * outage sends one readable message instead of one per state.
 *
 * @param lang notification language
 * @param lines texts of one category
 * @param max lines shown before the rest is counted
 */
export function joinLines(lang: Lang, lines: string[], max = 20): string {
    if (lines.length <= max) {
        return lines.join('\n');
    }
    const rest = lines.length - max;
    const more = lang === 'de' ? `… und ${rest} weitere.` : `… and ${rest} more.`;
    return [...lines.slice(0, max), more].join('\n');
}

/**
 * A rejected setting as the user typed it: strings quoted, numbers (NaN included) as they are.
 *
 * @param value rejected value
 */
function shown(value: unknown): string {
    return typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
}

/**
 * Why a watch was rejected. Fields are named by their label in the custom settings dialog.
 *
 * @param lang notification language
 * @param problem rejection from the watch list
 */
export function reasonText(lang: Lang, problem: WatchProblem): string {
    const de = lang === 'de';
    switch (problem.code) {
        case 'ownStates':
            return de
                ? 'Staleguard kann seine eigenen States nicht überwachen.'
                : 'Staleguard cannot watch its own states.';
        case 'timeout':
            return de
                ? `„Frist (min)“ muss eine ganze Zahl von 1 bis 10080 sein, eingestellt ist ${shown(problem.value)}.`
                : `'Deadline (min)' must be a whole number from 1 to 10080, but is ${shown(problem.value)}.`;
        case 'mode':
            return de
                ? `„Lebenszeichen“ muss "update" oder "change" sein, eingestellt ist ${shown(problem.value)}.`
                : `'Sign of life' must be "update" or "change", but is ${shown(problem.value)}.`;
        case 'attempts':
            return de
                ? `„Instanz-Neustarts pro Ausfall“ muss eine ganze Zahl von 0 bis 5 sein, eingestellt ist ${shown(problem.value)}.`
                : `'Instance restarts per outage' must be a whole number from 0 to 5, but is ${shown(problem.value)}.`;
        case 'noOwner':
            return de
                ? 'Instanz-Neustarts sind nur für States einer anderen Adapter-Instanz möglich.'
                : 'Instance restarts are only possible for states of another adapter instance.';
        case 'collision':
            return de
                ? `Die Kanal-ID kollidiert mit der Überwachung von ${problem.other}.`
                : `Its channel id collides with the watch of ${problem.other}.`;
        case 'cap':
            return de
                ? `Mehr als ${problem.max} überwachte States, dieser wird ignoriert.`
                : `More than ${problem.max} watched states, this one is ignored.`;
    }
}

/**
 * Custom settings of a state are invalid.
 *
 * @param lang notification language
 * @param id state id
 * @param problem rejection from the watch list
 */
export function invalidText(lang: Lang, id: string, problem: WatchProblem): string {
    const reason = reasonText(lang, problem);
    return lang === 'de'
        ? `Die Überwachung von ${id} ist ungültig eingestellt: ${reason}`
        : `The watch of ${id} has an invalid setting: ${reason}`;
}

/**
 * Restart call failed.
 *
 * @param lang notification language
 * @param instance instance that should have been restarted
 * @param error error message
 */
export function restartFailedText(lang: Lang, instance: string, error: string): string {
    return lang === 'de'
        ? `Neustart von ${instance} fehlgeschlagen: ${error}`
        : `Restarting ${instance} failed: ${error}`;
}
