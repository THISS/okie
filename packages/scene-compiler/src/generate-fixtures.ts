import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildC4ProjectionBundle, validateSnapshot } from '@okie/architecture';
import { compileC4Scene, compileC4Timeline } from './compile-c4.js';
import { goldenSnapshot, goldenStory, goldenView } from './golden-fixture.js';

const fixture = (path: string): string => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const snapshotIssues = validateSnapshot(goldenSnapshot);
if (snapshotIssues.length) throw new Error(`Invalid golden snapshot: ${JSON.stringify(snapshotIssues)}`);
await Promise.all(goldenSnapshot.entities.flatMap(entity => (entity.sourceExcerpts ?? []).map(async excerpt => {
  const actual = (await readFile(new URL(`../../../${excerpt.path}`, import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(excerpt.startLine - 1, excerpt.endLine);
  if (JSON.stringify(actual) !== JSON.stringify(excerpt.lines)) {
    throw new Error(`Stale frozen source excerpt for ${entity.id} at ${excerpt.path}:${excerpt.startLine}`);
  }
})));

const projections = buildC4ProjectionBundle(goldenSnapshot, {
  rootEntityId: 'system:okie',
  // Focus is the navigation root. Selection is deliberately not an input.
  focusEntityId: 'system:okie',
  familyId: 'view-family:okie-golden:system-root',
});
const compiled = compileC4Scene(goldenSnapshot, projections);
const timeline = compileC4Timeline(goldenSnapshot, goldenStory, compiled);

await Promise.all([
  writeFile(fixture('architecture/demo-snapshot.json'), json(goldenSnapshot)),
  writeFile(fixture('architecture/demo-view.json'), json(goldenView)),
  writeFile(fixture('architecture/demo-story.json'), json(goldenStory)),
  writeFile(fixture('renderer/demo-scene.json'), json(compiled.scene)),
  writeFile(fixture('renderer/demo-timeline.json'), json(timeline)),
  writeFile(fixture('renderer/demo-c4-projections.json'), json(projections)),
]);
