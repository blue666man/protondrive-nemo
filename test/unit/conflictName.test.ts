import assert from 'node:assert/strict';
import { test } from 'node:test';

import { conflictName } from '../../src/conflictName';

// Local time, as the name shows it to the user.
const WHEN = new Date(2026, 10, 2, 14, 5, 59);

test('the stamp goes before the extension', () => {
    assert.equal(conflictName('report.pdf', WHEN), 'report (conflict 2026-11-02 1405).pdf');
    assert.equal(conflictName('a.tar.gz', WHEN), 'a.tar (conflict 2026-11-02 1405).gz');
});

test('names without an extension, and dotfiles, get it at the end', () => {
    assert.equal(conflictName('Makefile', WHEN), 'Makefile (conflict 2026-11-02 1405)');
    assert.equal(conflictName('.bashrc', WHEN), '.bashrc (conflict 2026-11-02 1405)');
});

test('a second conflict in the same minute is numbered', () => {
    assert.equal(conflictName('report.pdf', WHEN, 2), 'report (conflict 2026-11-02 1405 2).pdf');
});
