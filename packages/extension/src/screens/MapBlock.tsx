import type { ChangeMap, Tier } from '@airlock/shared';

/**
 * The change map in reading order: each group, its layers, their files. `tiers` (path to tier) is shown, as written, when
 * the review's facts are known. `nested`: inside the review's "Files" fold, so it is not a card and its headings sit a
 * level lower.
 */
export function MapBlock({ map, tiers, nested = false }: { map: ChangeMap; tiers?: ReadonlyMap<string, Tier>; nested?: boolean }) {
  const [Top, Group, Layer] = nested ? (['h4', 'h5', 'h6'] as const) : (['h2', 'h3', 'h4'] as const);
  const Part = nested ? 'div' : 'section';
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
    <Part className={nested ? 'ap-part' : 'card'}>
      <Top className="label">Read in this order</Top>
      <ol className="plain">
        {map.cohorts.map((cohort) => (
          <li key={cohort.id}>
            <Group className="group">{cohort.title}</Group>
            <ol className="plain nested">
              {cohort.layers.map((layer) => (
                <li key={layer.id}>
                  <Layer className="layer">{layer.title}</Layer>
                  <ul className="plain nested">{layer.files.map(file)}</ul>
                </li>
              ))}
            </ol>
          </li>
        ))}
        {map.standalone.length > 0 && (
          <li>
            <Group className="group">Other files</Group>
            <ul className="plain nested">{map.standalone.map(file)}</ul>
          </li>
        )}
      </ol>
    </Part>
  );
}
