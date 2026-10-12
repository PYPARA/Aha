/** A clipped decoration: its opaque base keeps nested region images independent. */
export function AhaBackgroundLayer() {
  return (
    <div className="aha-background-layer" aria-hidden="true">
      <div className="aha-background-image" />
    </div>
  );
}
