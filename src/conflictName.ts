import path from 'node:path';

/**
 * The name under which a change that conflicts with Drive is kept, so that
 * it never overwrites a change made elsewhere:
 * `report (conflict 2026-11-02 1405).pdf` (local time). `n` > 1 numbers
 * further copies made in the same minute.
 */
export function conflictName(name: string, when: Date, n = 1): string {
    const ext = path.extname(name); // '' for 'Makefile' and '.bashrc'
    const stem = ext ? name.slice(0, -ext.length) : name;
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp =
        `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
        `${pad(when.getHours())}${pad(when.getMinutes())}`;
    return `${stem} (conflict ${stamp}${n > 1 ? ` ${n}` : ''})${ext}`;
}
