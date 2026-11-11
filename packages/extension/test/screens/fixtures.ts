import type { Brief, ChangeMap } from '@airlock/shared';
import type { PanelState, StageLine } from '../../src/state/reduce';
import { latestFor, prSummary } from '../helpers/fake-service';

export { latestFor, prSummary };

export const brief: Brief = {
  whatItDoes: ['Adds a totals column.', 'Rounds to cents.'],
  claims: [
    { text: 'Totals are rounded', verdict: 'verified', evidence: 'src/totals.ts line 4' },
    { text: 'Old rows are migrated', verdict: 'not-supported', evidence: 'No migration touches old rows.' },
    { text: 'Empty carts work', verdict: 'unclear', evidence: 'The test uses one item.' },
  ],
};

export const map: ChangeMap = {
  cohorts: [
    {
      id: 'c1', title: 'Totals', summary: '', neighbours: [], inferredLinks: [],
      layers: [
        { id: 'l1', title: 'Data layer', kind: 'data', files: ['db/001.sql'], dependsOn: [], note: '' },
        { id: 'l2', title: 'Screens layer', kind: 'screens', files: ['src/Cart.tsx', 'src/Totals.tsx'], dependsOn: ['l1'], note: '' },
      ],
    },
    {
      id: 'c2', title: 'Docs', summary: '', neighbours: [], inferredLinks: [],
      layers: [{ id: 'l3', title: 'Notes layer', kind: 'other', files: ['README.md'], dependsOn: [], note: '' }],
    },
  ],
  standalone: [],
  links: [],
};

export const stages: StageLine[] = [
  { stage: 'intake', words: 'Reading the pull request', status: 'done', detail: '' },
  { stage: 'map', words: 'Mapping the change', status: 'working', detail: '' },
];

export const running = (over: Partial<Extract<PanelState, { kind: 'running' }>> = {}): PanelState => ({
  kind: 'running', pr: prSummary(), stages, brief: null, map: null, ...over,
});
