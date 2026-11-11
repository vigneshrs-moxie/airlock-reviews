import type { ChangeMap, Tier } from '@airlock/shared';

/** The change map in reading order: each group, its layers, their files. `tiers` (path to tier) is shown, as written, when the review's facts are known. */
export function MapBlock({ map, tiers }: { map: ChangeMap; tiers?: ReadonlyMap<string, Tier> }) {
  const file = (path: string) => {
    const tier = tiers?.get(path);
    return (
      <li key={path} className="file">
        <code className="path">{path}</code>
        {tier !== undefined && <span className="tag">{tier}</span>}
      </li>
    );
  };
  return (
    <section className="card">
      <h2 className="label">Read in this order</h2>
      <ol className="plain">
        {map.cohorts.map((cohort) => (
          <li key={cohort.id}>
            <h3 className="group">{cohort.title}</h3>
            <ol className="plain nested">
              {cohort.layers.map((layer) => (
                <li key={layer.id}>
                  <h4 className="layer">{layer.title}</h4>
                  <ul className="plain nested">{layer.files.map(file)}</ul>
                </li>
              ))}
            </ol>
          </li>
        ))}
        {map.standalone.length > 0 && (
          <li>
            <h3 className="group">Other files</h3>
            <ul className="plain nested">{map.standalone.map(file)}</ul>
          </li>
        )}
      </ol>
    </section>
  );
}
