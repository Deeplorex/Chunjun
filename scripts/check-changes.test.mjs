import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChangeRecord } from './check-changes.mjs';

const args = {
  changedFiles: ['src/App.tsx', 'src/App.test.tsx', 'docs/changes.md'],
  currentRecord:
    '## 2026-11-02\nType: requirement\nTests: `src/App.test.tsx`\n',
  previousRecord: '',
  exists: () => true,
};
test('a changed behavior has a new entry and a real affected test', () =>
  assert.deepEqual(validateChangeRecord(args), []));
test('an unchanged record cannot cover new behavior', () =>
  assert.match(
    validateChangeRecord({ ...args, previousRecord: args.currentRecord })[0],
    /new/u,
  ));
test('non-bug entries may explain existing coverage', () =>
  assert.deepEqual(
    validateChangeRecord({
      ...args,
      changedFiles: ['src/App.tsx', 'docs/changes.md'],
      currentRecord: `${args.currentRecord}existing coverage: existing import failure test covers this change.\n`,
    }),
    [],
  ));
test('bugs require a changed regression even with an existing-coverage note', () =>
  assert.match(
    validateChangeRecord({
      ...args,
      changedFiles: ['src/App.tsx', 'docs/changes.md'],
      currentRecord:
        args.currentRecord.replace('requirement', 'bug') +
        'existing coverage: old test\n',
    }).join(),
    /regression/u,
  ));
test('missing cited tests are rejected', () =>
  assert.match(
    validateChangeRecord({ ...args, exists: () => false }).join(),
    /does not exist/u,
  ));
