/**
 * Notification texts. An ioBroker notification carries one finished string, so the text is built
 * in the system language here instead of through admin i18n.
 */

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
        ? `Der überwachte State ${id} existiert nicht oder hat noch keinen Wert.`
        : `The watched state ${id} does not exist or has no value yet.`;
}

/**
 * Custom settings of a state are invalid.
 *
 * @param lang notification language
 * @param id state id
 * @param reason validation message from the watch list
 */
export function invalidText(lang: Lang, id: string, reason: string): string {
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
