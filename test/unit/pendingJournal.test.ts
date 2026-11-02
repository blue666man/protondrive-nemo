import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { type JournalRecord, PendingJournal } from '../../src/pendingJournal';
import { tempDir } from '../helpers';

async function journalIn(t: TestContext): Promise<PendingJournal> {
    const tmp = tempDir();
    t.after(tmp.cleanup);
    const journal = new PendingJournal(path.join(tmp.dir, 'pending'));
    await journal.init();
    return journal;
}

function record(id: string, extra: Partial<JournalRecord> = {}): JournalRecord {
    return {
        id,
        kind: 'new',
        path: `/${id}.txt`,
        parentUid: 'root',
        name: `${id}.txt`,
        claimedMtime: 981173106000,
        attempts: 0,
        state: 'pending',
        ...extra,
    };
}

test('init creates a private directory', async (t) => {
    const journal = await journalIn(t);
    assert.equal(statSync(journal.dir).mode & 0o777, 0o700);
});

test('a written record loads back; records are private and no temp file is left', async (t) => {
    const journal = await journalIn(t);
    writeFileSync(journal.blobPath('a'), 'content');
    await journal.write(record('a'));
    await journal.write(record('a', { attempts: 2 }));
    assert.deepEqual(await journal.loadAll(), { records: [record('a', { attempts: 2 })], problems: [] });
    assert.equal(statSync(path.join(journal.dir, 'a.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(journal.dir).sort(), ['a.blob', 'a.json']);
});

test('remove deletes the record and its content', async (t) => {
    const journal = await journalIn(t);
    writeFileSync(journal.blobPath('a'), 'content');
    await journal.write(record('a'));
    await journal.remove('a');
    assert.deepEqual(readdirSync(journal.dir), []);
});

test('loadAll cleans up content without a record, records without content, and temp files', async (t) => {
    const journal = await journalIn(t);
    writeFileSync(journal.blobPath('orphan'), 'x');
    await journal.write(record('lost'));
    writeFileSync(path.join(journal.dir, 'b.json.tmp'), '{');
    const { records, problems } = await journal.loadAll();
    assert.deepEqual(records, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\/lost\.txt/);
    assert.deepEqual(readdirSync(journal.dir), []);
});

test('an unreadable record is moved aside and its content kept, also on the next start', async (t) => {
    const journal = await journalIn(t);
    writeFileSync(journal.blobPath('c'), 'precious');
    writeFileSync(path.join(journal.dir, 'c.json'), '{not json');
    const first = await journal.loadAll();
    assert.deepEqual(first.records, []);
    assert.match(first.problems[0], /c\.json/);
    await journal.loadAll();
    assert.deepEqual(readdirSync(journal.dir).sort(), ['c.blob', 'c.json.corrupt']);
});
