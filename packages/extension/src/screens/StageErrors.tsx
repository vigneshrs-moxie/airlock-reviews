import type { ChangeMap, StageError } from '@airlock/shared';

/** The stages that failed, each as `stage: message`, with the group's title when the failure was in one group. */
export function StageErrors({ errors, map }: { errors: readonly StageError[]; map: ChangeMap }) {
  if (errors.length === 0) return null;
  const group = (id: string | null): string => (id === null ? '' : `, ${map.cohorts.find((c) => c.id === id)?.title ?? id}`);
  return (
    <section className="card alert">
      <h2 className="label">Stage errors</h2>
      <ul className="plain">
        {errors.map((e, i) => <li key={i}>{`${e.stage}${group(e.cohortId)}: ${e.message}`}</li>)}
      </ul>
    </section>
  );
}
